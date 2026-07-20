import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { parseNote } from "../parser/markdown.js";
import { resolveLink, type ResolverIndex } from "../vault/resolve.js";
import { resolveWithinVault, toSafeVaultRelPath } from "../vault/paths.js";
import { filesystemErrorMessage, writeFileAtomic } from "../vault/write.js";
import type { VaultEngine } from "../vault-engine.js";
import { resolveNoteArg } from "./tools.js";

function serializeNote(frontmatter: Record<string, unknown>, body: string): string {
  return Object.keys(frontmatter).length > 0 ? matter.stringify(body, frontmatter) : body;
}

function saveParsedNote(
  engine: VaultEngine,
  relPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  const absPath = resolveWithinVault(engine.vaultDir, relPath);
  writeFileAtomic(absPath, serializeNote(frontmatter, body));
  engine.indexFileNow(relPath);
}

function countLiteral(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count++;
    offset += needle.length;
  }
  return count;
}

export interface ReplaceTextArgs {
  path: string;
  find: string;
  replace: string;
  all?: boolean;
  expectedOccurrences?: number;
}

export function replaceText(engine: VaultEngine, args: ReplaceTextArgs): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Error: note not found: ${args.path}`;
  if (!args.find) return "Error: find must not be empty.";

  const absPath = resolveWithinVault(engine.vaultDir, file.path);
  const raw = readFileSync(absPath, "utf8");
  const occurrences = countLiteral(raw, args.find);
  if (occurrences === 0) return `Error: text not found in ${file.path}. Nothing was written.`;
  if (args.expectedOccurrences !== undefined && occurrences !== args.expectedOccurrences) {
    return `Error: expected ${args.expectedOccurrences} occurrence(s), found ${occurrences}. Nothing was written.`;
  }
  if (!(args.all ?? false) && occurrences > 1) {
    return `Error: found ${occurrences} occurrences. Pass all: true or expectedOccurrences for an intentional multi-match edit.`;
  }

  const updated = args.all ? raw.split(args.find).join(args.replace) : raw.replace(args.find, args.replace);
  try {
    writeFileAtomic(absPath, updated);
    engine.indexFileNow(file.path);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  return `Replaced ${args.all ? occurrences : 1} occurrence(s) in ${file.path}.`;
}

export interface PatchSectionArgs {
  path: string;
  heading: string;
  content: string;
}

export function patchSection(engine: VaultEngine, args: PatchSectionArgs): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Error: note not found: ${args.path}`;
  const raw = readFileSync(resolveWithinVault(engine.vaultDir, file.path), "utf8");
  const parsed = parseNote(raw);
  const headingIndex = parsed.headings.findIndex(
    (heading) => heading.text.trim().toLowerCase() === args.heading.trim().toLowerCase(),
  );
  if (headingIndex === -1) return `Error: heading "${args.heading}" not found in ${file.path}. Nothing was written.`;

  const target = parsed.headings[headingIndex]!;
  const lines = parsed.body.split(/\r\n|\n/);
  let endLine = lines.length + 1;
  for (let i = headingIndex + 1; i < parsed.headings.length; i++) {
    if (parsed.headings[i]!.level <= target.level) {
      endLine = parsed.headings[i]!.line;
      break;
    }
  }
  const headingLineIndex = target.line - 1;
  const updatedBody = [
    ...lines.slice(0, headingLineIndex + 1),
    "",
    args.content.trim(),
    "",
    ...lines.slice(endLine - 1),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  try {
    saveParsedNote(engine, file.path, parsed.frontmatter, updatedBody);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  return `Replaced section "${target.text}" in ${file.path}.`;
}

export function updateFrontmatter(
  engine: VaultEngine,
  args: { path: string; fields: Record<string, unknown> },
): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Error: note not found: ${args.path}`;
  if (Object.keys(args.fields).length === 0) return "Error: fields must not be empty.";
  const raw = readFileSync(resolveWithinVault(engine.vaultDir, file.path), "utf8");
  const parsed = parseNote(raw);
  try {
    saveParsedNote(engine, file.path, { ...parsed.frontmatter, ...args.fields }, parsed.body);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  return `Updated frontmatter fields in ${file.path}: ${Object.keys(args.fields).join(", ")}.`;
}

export function removeFrontmatterField(engine: VaultEngine, args: { path: string; field: string }): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Error: note not found: ${args.path}`;
  const raw = readFileSync(resolveWithinVault(engine.vaultDir, file.path), "utf8");
  const parsed = parseNote(raw);
  if (!(args.field in parsed.frontmatter)) {
    return `Error: frontmatter field "${args.field}" not found in ${file.path}. Nothing was written.`;
  }
  const updated = { ...parsed.frontmatter };
  delete updated[args.field];
  try {
    saveParsedNote(engine, file.path, updated, parsed.body);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  return `Removed frontmatter field "${args.field}" from ${file.path}.`;
}

function stripMd(relPath: string): string {
  return relPath.toLowerCase().endsWith(".md") ? relPath.slice(0, -3) : relPath;
}

function maskInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (match) => " ".repeat(match.length));
}

function rewriteLinkLine(line: string, oldPath: string, newPath: string, resolverIndex: ResolverIndex): string {
  const masked = maskInlineCode(line);
  const wikiRegex = /(!?)\[\[([^\]]+)\]\]/g;
  const wikiMatches = [...masked.matchAll(wikiRegex)];
  let wikiUpdated = line;
  for (let i = wikiMatches.length - 1; i >= 0; i--) {
    const match = wikiMatches[i]!;
    const whole = match[0];
    const embed = match[1] ?? "";
    const inner = match[2] ?? "";
    const pipeIndex = inner.indexOf("|");
    const left = pipeIndex === -1 ? inner : inner.slice(0, pipeIndex);
    const alias = pipeIndex === -1 ? "" : inner.slice(pipeIndex);
    const hashIndex = left.indexOf("#");
    const target = (hashIndex === -1 ? left : left.slice(0, hashIndex)).trim();
    const fragment = hashIndex === -1 ? "" : left.slice(hashIndex);
    if (resolveLink(target, resolverIndex)?.path !== oldPath) continue;
    const replacement = `${embed}[[${stripMd(newPath)}${fragment}${alias}]]`;
    const index = match.index!;
    wikiUpdated = `${wikiUpdated.slice(0, index)}${replacement}${wikiUpdated.slice(index + whole.length)}`;
  }

  const markdownMasked = maskInlineCode(wikiUpdated);
  const markdownRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  const markdownMatches = [...markdownMasked.matchAll(markdownRegex)];
  let updated = wikiUpdated;
  for (let i = markdownMatches.length - 1; i >= 0; i--) {
    const match = markdownMatches[i]!;
    const whole = match[0];
    const label = match[1] ?? "";
    const rawTarget = match[2] ?? "";
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(rawTarget) || /^mailto:/i.test(rawTarget) || rawTarget.startsWith("#")) {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawTarget.trim());
    } catch {
      decoded = rawTarget.trim();
    }
    const hashIndex = decoded.indexOf("#");
    const target = hashIndex === -1 ? decoded : decoded.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : decoded.slice(hashIndex);
    if (resolveLink(target, resolverIndex)?.path !== oldPath) continue;
    const replacement = `[${label}](${encodeURI(newPath)}${fragment})`;
    const index = match.index!;
    updated = `${updated.slice(0, index)}${replacement}${updated.slice(index + whole.length)}`;
  }
  return updated;
}

function rewriteLinks(content: string, oldPath: string, newPath: string, resolverIndex: ResolverIndex): string {
  let inFence = false;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  return content
    .split(/\r\n|\n/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : rewriteLinkLine(line, oldPath, newPath, resolverIndex);
    })
    .join(newline);
}

export interface MoveNoteArgs {
  from: string;
  to: string;
  updateLinks?: boolean;
}

export function moveNote(engine: VaultEngine, args: MoveNoteArgs): string {
  const source = resolveNoteArg(engine, args.from);
  if (!source) return `Error: note not found: ${args.from}`;
  let newPath: string;
  try {
    newPath = toSafeVaultRelPath(args.to);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  if (newPath === source.path) return `Error: source and destination are the same: ${source.path}`;
  const oldAbs = resolveWithinVault(engine.vaultDir, source.path);
  const newAbs = resolveWithinVault(engine.vaultDir, newPath);
  if (existsSync(newAbs)) return `Error: destination already exists: ${newPath}`;

  const updateLinks = args.updateLinks ?? true;
  const resolverIndex = engine.db.buildResolverIndex();
  const rewritten = new Map<string, string>();
  if (updateLinks) {
    for (const file of engine.db.getAllFiles().filter((row) => row.is_markdown === 1)) {
      const raw = readFileSync(resolveWithinVault(engine.vaultDir, file.path), "utf8");
      const changed = rewriteLinks(raw, source.path, newPath, resolverIndex);
      if (changed !== raw) rewritten.set(file.path, changed);
    }
  }

  const backups = new Map<string, string>();
  try {
    for (const relPath of rewritten.keys()) {
      backups.set(relPath, readFileSync(resolveWithinVault(engine.vaultDir, relPath), "utf8"));
    }
    mkdirSync(path.dirname(newAbs), { recursive: true });
    renameSync(oldAbs, newAbs);
    for (const [relPath, content] of rewritten) {
      const targetPath = relPath === source.path ? newPath : relPath;
      writeFileAtomic(resolveWithinVault(engine.vaultDir, targetPath), content);
    }
    engine.refreshNow();
  } catch (err) {
    try {
      if (existsSync(newAbs) && !existsSync(oldAbs)) renameSync(newAbs, oldAbs);
      for (const [relPath, content] of backups) writeFileAtomic(resolveWithinVault(engine.vaultDir, relPath), content);
      engine.refreshNow();
    } catch {
      // Report the original error; a restart/full scan will reconcile the index.
    }
    return `Error: move failed and rollback was attempted: ${filesystemErrorMessage(err, newAbs)}`;
  }
  return `Moved ${source.path} to ${newPath}; updated links in ${rewritten.size} note(s).`;
}

export function renameNote(
  engine: VaultEngine,
  args: { path: string; newName: string; updateLinks?: boolean },
): string {
  if (!args.newName.trim() || /[\\/]/.test(args.newName)) {
    return "Error: newName must be a filename, not a path. Use move_note to change folders.";
  }
  const source = resolveNoteArg(engine, args.path);
  if (!source) return `Error: note not found: ${args.path}`;
  const destination = path.posix.join(path.posix.dirname(source.path), args.newName);
  return moveNote(engine, { from: source.path, to: destination, updateLinks: args.updateLinks });
}

export function deleteNote(engine: VaultEngine, args: { path: string; force?: boolean; permanent?: boolean }): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Error: note not found: ${args.path}`;
  const backlinks = engine.db.getBacklinks(file.path);
  if (backlinks.length > 0 && !(args.force ?? false)) {
    return `Error: ${file.path} has ${backlinks.length} backlink(s). Pass force: true to delete it intentionally.`;
  }
  const absPath = resolveWithinVault(engine.vaultDir, file.path);
  try {
    if (args.permanent ?? false) {
      unlinkSync(absPath);
      engine.deleteFileNow(file.path);
      return `Permanently deleted ${file.path}.`;
    }
    const trashRel = `.trash/${file.path}`;
    let trashAbs = resolveWithinVault(engine.vaultDir, trashRel);
    if (existsSync(trashAbs)) {
      const parsed = path.posix.parse(trashRel);
      trashAbs = resolveWithinVault(engine.vaultDir, `${parsed.dir}/${parsed.name}-${Date.now()}${parsed.ext}`);
    }
    mkdirSync(path.dirname(trashAbs), { recursive: true });
    renameSync(absPath, trashAbs);
    engine.deleteFileNow(file.path);
    return `Moved ${file.path} to the vault trash (${path.relative(engine.vaultDir, trashAbs)}).`;
  } catch (err) {
    return `Error: ${filesystemErrorMessage(err, absPath)}`;
  }
}

interface RollbackManifest {
  id: string;
  createdAt: string;
  files: { path: string; content: string }[];
}

function rollbackDir(engine: VaultEngine): string {
  return path.join(engine.vaultDir, ".obsidian-everywhere", "rollbacks");
}

function compilePattern(pattern: string, regex: boolean, caseSensitive: boolean): RegExp | null {
  if (!pattern) throw new Error("find must not be empty");
  if (pattern.length > 500) throw new Error("find pattern is too long (max 500 characters)");
  if (!regex) return null;
  return new RegExp(pattern, caseSensitive ? "g" : "gi");
}

function replacementFor(
  content: string,
  find: string,
  replacement: string,
  regex: RegExp | null,
): { text: string; count: number } {
  if (!regex) {
    const count = countLiteral(content, find);
    return { text: count ? content.split(find).join(replacement) : content, count };
  }
  regex.lastIndex = 0;
  const count = [...content.matchAll(regex)].length;
  regex.lastIndex = 0;
  const text = content.replace(regex, replacement);
  return { text, count };
}

export interface BulkReplaceArgs {
  find: string;
  replace: string;
  folder?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  dryRun?: boolean;
  maxFiles?: number;
}

export function bulkReplace(engine: VaultEngine, args: BulkReplaceArgs): string {
  let regex: RegExp | null;
  try {
    regex = compilePattern(args.find, args.regex ?? false, args.caseSensitive ?? true);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  const folder = args.folder?.replace(/^\/+|\/+$/g, "");
  const candidates = engine.db
    .getAllFiles()
    .filter((file) => file.is_markdown === 1 && (!folder || file.path.startsWith(`${folder}/`)));
  const changes: { path: string; before: string; after: string; count: number }[] = [];
  for (const file of candidates) {
    const before = readFileSync(resolveWithinVault(engine.vaultDir, file.path), "utf8");
    const result = replacementFor(before, args.find, args.replace, regex);
    if (result.count > 0) changes.push({ path: file.path, before, after: result.text, count: result.count });
  }
  if (changes.length === 0) return "No matches found. Nothing was written.";
  const total = changes.reduce((sum, change) => sum + change.count, 0);
  const summary = changes.map((change) => `- ${change.path}: ${change.count} replacement(s)`).join("\n");
  if (args.dryRun ?? true) return `Dry run: ${total} replacement(s) in ${changes.length} file(s).\n\n${summary}`;
  const maxFiles = args.maxFiles ?? 100;
  if (changes.length > maxFiles) {
    return `Error: ${changes.length} files would change, exceeding maxFiles=${maxFiles}. Nothing was written.`;
  }

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 10)}`;
  const manifest: RollbackManifest = {
    id,
    createdAt: new Date().toISOString(),
    files: changes.map((change) => ({ path: change.path, content: change.before })),
  };
  const manifestPath = path.join(rollbackDir(engine), `${id}.json`);
  try {
    writeFileAtomic(manifestPath, JSON.stringify(manifest));
    for (const change of changes) writeFileAtomic(resolveWithinVault(engine.vaultDir, change.path), change.after);
    engine.refreshNow();
  } catch (err) {
    for (const change of changes) {
      try {
        writeFileAtomic(resolveWithinVault(engine.vaultDir, change.path), change.before);
      } catch {
        // Continue restoring the remaining files.
      }
    }
    engine.refreshNow();
    return `Error: bulk edit failed and rollback was attempted: ${filesystemErrorMessage(err)}`;
  }
  return `Applied ${total} replacement(s) in ${changes.length} file(s). Rollback ID: ${id}\n\n${summary}`;
}

export function rollbackBulkEdit(engine: VaultEngine, args: { rollbackId: string }): string {
  if (!/^[A-Za-z0-9-]+$/.test(args.rollbackId)) return "Error: invalid rollback ID.";
  const manifestPath = path.join(rollbackDir(engine), `${args.rollbackId}.json`);
  if (!existsSync(manifestPath)) return `Error: rollback not found: ${args.rollbackId}`;
  let manifest: RollbackManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RollbackManifest;
    for (const file of manifest.files) {
      const safePath = toSafeVaultRelPath(file.path);
      writeFileAtomic(resolveWithinVault(engine.vaultDir, safePath), file.content);
    }
    engine.refreshNow();
  } catch (err) {
    return `Error: rollback failed: ${filesystemErrorMessage(err)}`;
  }
  return `Restored ${manifest.files.length} file(s) from rollback ${manifest.id}.`;
}
