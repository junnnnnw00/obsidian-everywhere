import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseNote } from "../parser/markdown.js";
import type { ParsedLink } from "../parser/types.js";
import { DEFAULT_EXCLUDE_DIRS, isMarkdownPath, shouldExclude, toPosixPath } from "../vault/paths.js";
import type { LinkChange } from "./db.js";
import type { VaultDB } from "./db.js";

export interface DiskFile {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  size: number;
}

export interface ScanResult {
  addedFiles: string[];
  updatedFiles: string[];
  removedFiles: string[];
  linkChanges: LinkChange[];
}

export function walkVaultFiles(vaultDir: string, excludeDirs: string[] = DEFAULT_EXCLUDE_DIRS): DiskFile[] {
  const results: DiskFile[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosixPath(path.relative(vaultDir, abs));
      if (shouldExclude(rel, excludeDirs)) continue;
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const stat = statSync(abs);
        // Canonicalize to NFC for the DB identity (`relPath`) while keeping
        // `absPath` byte-exact for disk I/O below. A dumb filesystem (exFAT,
        // FAT32 — the common case for an external drive) can store a
        // filename however the writer originally composed it, often NFD for
        // Korean/accented text; without this, the same note could be
        // "not found" for a caller using the NFC form (the normal form for
        // JSON payloads and most non-macOS text).
        results.push({ relPath: rel.normalize("NFC"), absPath: abs, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  }

  walk(vaultDir);
  return results;
}

function hashFile(file: DiskFile, isMarkdown: boolean): { hash: string; content: string | null } {
  if (isMarkdown) {
    const content = readFileSync(file.absPath, "utf8");
    const hash = createHash("sha1").update(content).digest("hex");
    return { hash, content };
  }
  const hash = createHash("sha1")
    .update(`${file.size}:${Math.round(file.mtimeMs)}`)
    .digest("hex");
  return { hash, content: null };
}

/** Parse + upsert a single file's metadata and derived tables (not link resolution). Returns pending links for later resolution, or null if the file is unchanged. */
function upsertFileContent(
  db: VaultDB,
  file: DiskFile,
): { status: "added" | "updated" | "unchanged"; fileId: number; links: ParsedLink[] } {
  const isMarkdown = isMarkdownPath(file.relPath);
  const { hash, content } = hashFile(file, isMarkdown);
  const existing = db.getFileByPath(file.relPath);

  if (existing && existing.hash === hash) {
    return { status: "unchanged", fileId: existing.id, links: [] };
  }

  if (!isMarkdown) {
    const fileId = db.upsertFileMeta({
      path: file.relPath,
      isMarkdown: false,
      mtime: Math.round(file.mtimeMs),
      hash,
      title: null,
      frontmatterJson: null,
      rawContent: null,
    });
    return { status: existing ? "updated" : "added", fileId, links: [] };
  }

  const parsed = parseNote(content ?? "");
  const title = parsed.title ?? path.basename(file.relPath, path.extname(file.relPath));
  const fileId = db.upsertFileMeta({
    path: file.relPath,
    isMarkdown: true,
    mtime: Math.round(file.mtimeMs),
    hash,
    title,
    frontmatterJson: JSON.stringify(parsed.frontmatter ?? {}),
    rawContent: parsed.body,
  });
  db.replaceAliases(fileId, parsed.aliases);
  db.replaceTags(fileId, parsed.tags);
  db.replaceHeadings(fileId, parsed.headings);
  db.replaceBlocks(fileId, parsed.blocks);

  return { status: existing ? "updated" : "added", fileId, links: parsed.links };
}

/** Full vault scan: only changed/new files are re-parsed (mtime+hash short-circuit). */
export function fullScan(db: VaultDB, vaultDir: string, excludeDirs: string[] = DEFAULT_EXCLUDE_DIRS): ScanResult {
  const diskFiles = walkVaultFiles(vaultDir, excludeDirs);
  const diskPaths = new Set(diskFiles.map((f) => f.relPath));

  const removedFiles: string[] = [];
  for (const existing of db.getAllFiles()) {
    if (!diskPaths.has(existing.path)) {
      db.deleteFileByPath(existing.path);
      removedFiles.push(existing.path);
    }
  }

  const addedFiles: string[] = [];
  const updatedFiles: string[] = [];
  const pendingLinks = new Map<number, ParsedLink[]>();

  for (const file of diskFiles) {
    const result = upsertFileContent(db, file);
    if (result.status === "added") addedFiles.push(file.relPath);
    if (result.status === "updated") updatedFiles.push(file.relPath);
    if (result.links.length > 0 || result.status !== "unchanged") {
      pendingLinks.set(result.fileId, result.links);
    }
  }

  const resolverIndex = db.buildResolverIndex();
  for (const [fileId, links] of pendingLinks) {
    db.replaceLinks(fileId, links, resolverIndex);
  }

  const linkChanges = db.reresolveAllLinks(resolverIndex);

  return { addedFiles, updatedFiles, removedFiles, linkChanges };
}

/**
 * Apply a single filesystem event (create/change) incrementally. `relPath`
 * is used byte-exact to build `absPath` (it must match whatever's really on
 * disk), but the DB identity is its NFC form — see `walkVaultFiles`.
 */
export function applyFileUpsert(db: VaultDB, vaultDir: string, relPath: string): ScanResult {
  const absPath = path.join(vaultDir, relPath.split("/").join(path.sep));
  const stat = statSync(absPath);
  const canonicalRelPath = relPath.normalize("NFC");
  const file: DiskFile = { relPath: canonicalRelPath, absPath, mtimeMs: stat.mtimeMs, size: stat.size };

  const result = upsertFileContent(db, file);
  const resolverIndex = db.buildResolverIndex();
  if (result.links.length > 0 || result.status !== "unchanged") {
    db.replaceLinks(result.fileId, result.links, resolverIndex);
  }
  const linkChanges = db.reresolveAllLinks(resolverIndex);

  return {
    addedFiles: result.status === "added" ? [canonicalRelPath] : [],
    updatedFiles: result.status === "updated" ? [canonicalRelPath] : [],
    removedFiles: [],
    linkChanges,
  };
}

/** Apply a single filesystem delete event incrementally. */
export function applyFileDelete(db: VaultDB, relPath: string): ScanResult {
  const canonicalRelPath = relPath.normalize("NFC");
  const removedId = db.deleteFileByPath(canonicalRelPath);
  if (removedId === null) {
    return { addedFiles: [], updatedFiles: [], removedFiles: [], linkChanges: [] };
  }
  const resolverIndex = db.buildResolverIndex();
  const linkChanges = db.reresolveAllLinks(resolverIndex);
  return { addedFiles: [], updatedFiles: [], removedFiles: [canonicalRelPath], linkChanges };
}

/** Rename = delete old path + upsert new path, re-resolving links across the vault. */
export function applyFileRename(db: VaultDB, vaultDir: string, oldRelPath: string, newRelPath: string): ScanResult {
  const canonicalOldRelPath = oldRelPath.normalize("NFC");
  db.deleteFileByPath(canonicalOldRelPath);
  const upsertResult = applyFileUpsert(db, vaultDir, newRelPath);
  return {
    addedFiles: upsertResult.addedFiles,
    updatedFiles: upsertResult.updatedFiles,
    removedFiles: [canonicalOldRelPath],
    linkChanges: upsertResult.linkChanges,
  };
}
