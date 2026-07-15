import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { FileRow } from "../index/db.js";
import { parseNote } from "../parser/markdown.js";
import { resolveLink } from "../vault/resolve.js";
import { resolveWithinVault, toSafeVaultRelPath } from "../vault/paths.js";
import type { VaultEngine } from "../vault-engine.js";
import { estimateTokens, extractSection, firstParagraph, formatFrontmatter, truncateToTokens } from "./format.js";

/** Resolve a user-supplied note reference (path, alias, or bare title) using the same semantics as in-vault links. */
export function resolveNoteArg(engine: VaultEngine, input: string): FileRow | undefined {
  const direct = engine.db.getFileByPath(input) ?? engine.db.getFileByPath(`${input}.md`);
  if (direct) return direct;
  const index = engine.db.buildResolverIndex();
  const resolved = resolveLink(input, index);
  return resolved ? engine.db.getFileByPath(resolved.path) : undefined;
}

export function vaultOverview(engine: VaultEngine): string {
  const files = engine.db.getAllFiles();
  const mdFiles = files.filter((f) => f.is_markdown === 1);
  const attachmentCount = files.length - mdFiles.length;
  const tagCounts = engine.db.getAllTagCounts().slice(0, 10);
  const hubs = engine.graph.pagerank().slice(0, 5);
  const recent = [...mdFiles].sort((a, b) => b.mtime - a.mtime).slice(0, 5);

  const lines: string[] = [
    "# Vault Overview",
    "",
    `- **Notes**: ${mdFiles.length} markdown notes, ${attachmentCount} attachments`,
    `- **Resolved links (graph edges)**: ${engine.db.countResolvedLinks()}`,
    `- **Unresolved links**: ${engine.db.findUnresolved().length}`,
    "",
    "## Top tags",
    ...(tagCounts.length ? tagCounts.map((t) => `- #${t.tag} (${t.count})`) : ["_no tags_"]),
    "",
    "## Hub notes (by PageRank)",
    ...(hubs.length
      ? hubs.map((h, i) => `${i + 1}. [[${h.path}]]${h.title ? ` — ${h.title}` : ""} (score ${h.score.toFixed(4)})`)
      : ["_vault has no linked notes yet_"]),
    "",
    "## Recently modified",
    ...(recent.length ? recent.map((f) => `- [[${f.path}]] — ${new Date(f.mtime).toISOString()}`) : ["_no notes_"]),
  ];
  return lines.join("\n");
}

export interface SearchNotesArgs {
  query?: string;
  tag?: string;
  folder?: string;
  limit?: number;
}

export function searchNotes(engine: VaultEngine, args: SearchNotesArgs): string {
  const limit = args.limit ?? 10;
  let candidates: FileRow[];

  if (args.query && args.query.trim().length > 0) {
    const hits = engine.db.search(args.query.trim(), Math.max(limit * 3, 30));
    candidates = hits.map((h) => engine.db.getFileByPath(h.path)).filter((f): f is FileRow => Boolean(f));
  } else {
    candidates = engine.db.getAllFiles().filter((f) => f.is_markdown === 1);
  }

  if (args.folder) {
    const prefix = args.folder.endsWith("/") ? args.folder : `${args.folder}/`;
    candidates = candidates.filter((f) => f.path.startsWith(prefix));
  }
  if (args.tag) {
    candidates = candidates.filter((f) =>
      engine.db.getTagsForFile(f.id).some((t) => t.tag === args.tag || t.tag.startsWith(`${args.tag}/`)),
    );
  }

  candidates = candidates.slice(0, limit);

  if (candidates.length === 0) return "No matching notes found.";

  const lines: string[] = [`# Search Results (${candidates.length})`, ""];
  for (const f of candidates) {
    const outCount = engine.db.getOutlinks(f.path).length;
    const backCount = engine.db.getBacklinks(f.path).length;
    const tags = engine.db.getTagsForFile(f.id).map((t) => `#${t.tag}`);
    lines.push(`## [[${f.path}]]${f.title ? ` — ${f.title}` : ""}`);
    lines.push(`- links: ${outCount} out / ${backCount} in`);
    if (tags.length) lines.push(`- tags: ${tags.join(" ")}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export interface ReadNoteArgs {
  path: string;
  heading?: string;
}

export function readNote(engine: VaultEngine, args: ReadNoteArgs): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Note not found: ${args.path}`;

  const outlinks = engine.db.getOutlinks(file.path);
  const backlinks = engine.db.getBacklinks(file.path);
  const tags = engine.db.getTagsForFile(file.id).map((t) => `#${t.tag}`);
  const frontmatter = formatFrontmatter(file.frontmatter_json);

  const body = file.raw_content ?? "";
  let bodyOut = body;
  if (args.heading) {
    const headings = engine.db.getHeadingsForFile(file.id);
    const section = extractSection(body, headings, args.heading);
    bodyOut = section ?? `_(heading "${args.heading}" not found — showing full note)_\n\n${body}`;
  }

  const lines: string[] = [
    `# ${file.title ?? file.path}`,
    `*${file.path}*`,
    "",
    "## Graph Context",
    `- **Outlinks (${outlinks.length})**: ${outlinks.length ? outlinks.map((l) => (l.targetPath ? `[[${l.targetPath}]]` : `${l.targetRaw} (unresolved)`)).join(", ") : "_none_"}`,
    `- **Backlinks (${backlinks.length})**: ${backlinks.length ? backlinks.map((b) => `[[${b.sourcePath}]]`).join(", ") : "_none_"}`,
    `- **Tags**: ${tags.length ? tags.join(" ") : "_none_"}`,
    ...(frontmatter ? ["- **Frontmatter**:", frontmatter] : []),
    "",
    "---",
    "",
    bodyOut,
  ];
  return lines.join("\n");
}

export function getBacklinks(engine: VaultEngine, args: { path: string }): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Note not found: ${args.path}`;
  const backlinks = engine.db.getBacklinks(file.path);
  if (backlinks.length === 0) return `# Backlinks for ${file.path}\n\n_none_`;
  const lines = [`# Backlinks for ${file.path} (${backlinks.length})`, ""];
  for (const b of backlinks) {
    lines.push(
      `- **[[${b.sourcePath}]]** (${b.type}${b.line ? `, line ${b.line}` : ""}): ${b.context ? `"${b.context}"` : ""}`,
    );
  }
  return lines.join("\n");
}

export interface NeighborhoodArgs {
  path: string;
  hops?: number;
}

export function getNeighborhood(engine: VaultEngine, args: NeighborhoodArgs): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Note not found: ${args.path}`;
  const hops = args.hops ?? 2;
  const { nodes, edges } = engine.graph.neighborhood(file.id, hops);

  const lines: string[] = [`# Neighborhood of ${file.path} (hops=${hops})`, "", `## Nodes (${nodes.length})`];
  for (const n of nodes) {
    lines.push(`- [[${n.path}]]${n.id === file.id ? " (center)" : ""}${n.title ? ` — ${n.title}` : ""}`);
  }
  lines.push("", `## Edges (${edges.length})`);
  const pathOf = new Map(nodes.map((n) => [n.id, n.path]));
  for (const e of edges) {
    lines.push(`- ${pathOf.get(e.source)} → ${pathOf.get(e.target)} (${e.type})`);
  }
  return lines.join("\n");
}

export interface ContextBundleArgs {
  topic: string;
  tokenBudget?: number;
}

function relationLabel(
  edges: { source: number; target: number; type: string }[],
  centerId: number,
  neighborId: number,
): string {
  const rels = new Set<string>();
  for (const e of edges) {
    if (e.source === centerId && e.target === neighborId) rels.add(`→ ${e.type}`);
    if (e.source === neighborId && e.target === centerId) rels.add(`← ${e.type}`);
  }
  return rels.size ? [...rels].join(", ") : "related";
}

export function getContextBundle(engine: VaultEngine, args: ContextBundleArgs): string {
  const tokenBudget = args.tokenBudget ?? 4000;
  let center = resolveNoteArg(engine, args.topic);
  if (!center) {
    const hits = engine.db.search(args.topic, 1);
    center = hits[0] ? engine.db.getFileByPath(hits[0].path) : undefined;
  }
  if (!center) return `No note found matching topic: ${args.topic}`;

  let budget = tokenBudget;
  const parts: string[] = [];

  const header = `# Context Bundle: ${center.title ?? center.path}\n\n*Center note: ${center.path} (token budget: ${tokenBudget})*\n`;
  parts.push(header);
  budget -= estimateTokens(header);

  const centerBody = center.raw_content ?? "";
  let centerBlock = `\n## ${center.path} (center)\n\n${centerBody}\n`;
  if (estimateTokens(centerBlock) > budget) centerBlock = truncateToTokens(centerBlock, Math.max(budget, 100));
  parts.push(centerBlock);
  budget -= estimateTokens(centerBlock);

  const { nodes, edges } = engine.graph.neighborhood(center.id, 1);
  const neighbors = nodes
    .filter((n) => n.id !== center!.id)
    .map((n) => {
      const row = engine.db.getFileById(n.id)!;
      return { n, row, backlinkCount: engine.db.getBacklinks(n.path).length };
    })
    .sort((a, b) => b.backlinkCount - a.backlinkCount || b.row.mtime - a.row.mtime);

  const neighborBlocks: string[] = [];
  for (const { n, row } of neighbors) {
    if (budget < 30) break;
    const excerpt = row.is_markdown === 1 ? firstParagraph(row.raw_content ?? "") : "(attachment)";
    const relation = relationLabel(edges, center.id, n.id);
    let block = `\n## ${row.path} (${relation})\n\n${excerpt}\n`;
    const cost = estimateTokens(block);
    if (cost > budget) {
      block = truncateToTokens(block, budget);
      neighborBlocks.push(block);
      budget -= estimateTokens(block);
      break;
    }
    neighborBlocks.push(block);
    budget -= cost;
  }

  parts.push(...neighborBlocks);
  const used = tokenBudget - budget;
  parts.push(
    `\n---\n*(≈${used}/${tokenBudget} tokens used, ${neighborBlocks.length}/${neighbors.length} neighbors included)*`,
  );

  return parts.join("").trim();
}

export function listTags(engine: VaultEngine): string {
  interface TagNode {
    count: number;
    children: Map<string, TagNode>;
  }
  const root: TagNode = { count: 0, children: new Map() };
  for (const { tag, count } of engine.db.getAllTagCounts()) {
    const parts = tag.split("/");
    let node = root;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = { count: 0, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.count = count;
  }

  function render(node: TagNode, depth: number): string[] {
    const out: string[] = [];
    const sortedKeys = [...node.children.keys()].sort();
    for (const key of sortedKeys) {
      const child = node.children.get(key)!;
      const suffix = child.count > 0 ? ` (${child.count})` : "";
      out.push(`${"  ".repeat(depth)}- #${key}${suffix}`);
      out.push(...render(child, depth + 1));
    }
    return out;
  }

  const body = render(root, 0);
  return ["# Tags", "", ...(body.length ? body : ["_no tags_"])].join("\n");
}

export function getNotesByTag(engine: VaultEngine, args: { tag: string; includeNested?: boolean }): string {
  const includeNested = args.includeNested ?? true;
  const notes = engine.db.getNotesByTag(args.tag, includeNested);
  if (notes.length === 0) return `# Notes tagged #${args.tag}\n\n_none_`;
  const lines = [`# Notes tagged #${args.tag} (${notes.length})`, ""];
  for (const n of notes) lines.push(`- [[${n.path}]]${n.title ? ` — ${n.title}` : ""}`);
  return lines.join("\n");
}

export function findOrphans(engine: VaultEngine): string {
  const orphans = engine.db.findOrphans();
  if (orphans.length === 0) return "# Orphan Notes\n\n_none — every note is connected_";
  const lines = [`# Orphan Notes (${orphans.length})`, "", "_Notes with no outgoing or incoming links:_", ""];
  for (const o of orphans) lines.push(`- [[${o.path}]]`);
  return lines.join("\n");
}

export interface FindPathArgs {
  from: string;
  to: string;
}

export function findPath(engine: VaultEngine, args: FindPathArgs): string {
  const fromFile = resolveNoteArg(engine, args.from);
  if (!fromFile) return `Note not found: ${args.from}`;
  const toFile = resolveNoteArg(engine, args.to);
  if (!toFile) return `Note not found: ${args.to}`;

  const path = engine.graph.shortestPath(fromFile.id, toFile.id);
  if (!path)
    return `# Path from ${fromFile.path} to ${toFile.path}\n\nNo connection found — the notes are in disconnected parts of the graph.`;

  const lines: string[] = [
    `# Path from ${fromFile.path} to ${toFile.path}`,
    "",
    `${path.length - 1} hop${path.length - 1 === 1 ? "" : "s"} via: ${path.map((n) => `[[${n.path}]]`).join(" → ")}`,
    "",
  ];
  for (const node of path) {
    const row = engine.db.getFileById(node.id);
    const summary = row && row.is_markdown === 1 ? firstParagraph(row.raw_content ?? "") : "(attachment)";
    lines.push(`## ${node.path}`, summary || "_(no content)_", "");
  }
  return lines.join("\n").trim();
}

export interface GetRelatedArgs {
  path: string;
  limit?: number;
}

function featureSet(engine: VaultEngine, fileId: number): Set<string> {
  const features = new Set<string>();
  for (const t of engine.db.getTagsForFile(fileId)) features.add(`tag:${t.tag}`);
  const { nodes } = engine.graph.neighborhood(fileId, 1);
  for (const n of nodes) {
    if (n.id !== fileId) features.add(`node:${n.id}`);
  }
  return features;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Similar notes via Jaccard similarity of {shared tags} ∪ {shared 1-hop neighbors} — deliberately not requiring a direct link. */
export function getRelated(engine: VaultEngine, args: GetRelatedArgs): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Note not found: ${args.path}`;
  const limit = args.limit ?? 5;

  const { nodes: directNeighbors } = engine.graph.neighborhood(file.id, 1);
  const directNeighborIds = new Set(directNeighbors.map((n) => n.id));
  const targetFeatures = featureSet(engine, file.id);

  const scored = engine.db
    .getAllFiles()
    .filter((f) => f.is_markdown === 1 && f.id !== file.id && !directNeighborIds.has(f.id))
    .map((f) => ({ f, score: jaccard(targetFeatures, featureSet(engine, f.id)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) {
    return `# Related to ${file.path}\n\n_No similar notes found (based on shared tags/neighbors, excluding directly-linked notes)._`;
  }

  const lines = [`# Related to ${file.path}`, "", "_Similar by shared tags/neighbors, not direct links:_", ""];
  for (const { f, score } of scored) {
    lines.push(`- [[${f.path}]]${f.title ? ` — ${f.title}` : ""} (similarity ${score.toFixed(2)})`);
  }
  return lines.join("\n");
}

export function findUnresolved(engine: VaultEngine): string {
  const rows = engine.db.findUnresolved();
  if (rows.length === 0) return "# Unresolved Links\n\n_none — every link resolves_";

  const byTarget = new Map<
    string,
    { sourcePath: string; line: number | null; heading: string | null; blockId: string | null }[]
  >();
  for (const r of rows) {
    const list = byTarget.get(r.targetRaw) ?? [];
    list.push({ sourcePath: r.sourcePath, line: r.line, heading: r.heading, blockId: r.blockId });
    byTarget.set(r.targetRaw, list);
  }

  const lines = [`# Unresolved Links (${byTarget.size})`, ""];
  for (const [target, sources] of byTarget) {
    lines.push(`- **${target}** — referenced from:`);
    for (const s of sources) {
      const fragment = s.blockId ? `#^${s.blockId}` : s.heading ? `#${s.heading}` : "";
      lines.push(`  - [[${s.sourcePath}${fragment}]]${s.line ? ` (line ${s.line})` : ""}`);
    }
  }
  return lines.join("\n");
}

// --- write tools -----------------------------------------------------

export interface CreateNoteArgs {
  path: string;
  content?: string;
  frontmatter?: Record<string, unknown>;
  overwrite?: boolean;
}

export function createNote(engine: VaultEngine, args: CreateNoteArgs): string {
  let relPath: string;
  let absPath: string;
  try {
    relPath = toSafeVaultRelPath(args.path);
    absPath = resolveWithinVault(engine.vaultDir, relPath);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  if (existsSync(absPath) && !args.overwrite) {
    return `Error: ${relPath} already exists. Pass overwrite: true to replace it, or use append_to_note to add to it.`;
  }

  const body = args.content ?? "";
  const fileText =
    args.frontmatter && Object.keys(args.frontmatter).length > 0 ? matter.stringify(body, args.frontmatter) : body;

  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, fileText, "utf8");
  engine.indexFileNow(relPath);

  return `Created ${relPath}.\n\n${readNote(engine, { path: relPath })}`;
}

export interface AppendToNoteArgs {
  path: string;
  content: string;
  heading?: string;
}

export function appendToNote(engine: VaultEngine, args: AppendToNoteArgs): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Error: note not found: ${args.path}. Use create_note to make a new one.`;

  const absPath = resolveWithinVault(engine.vaultDir, file.path);
  const raw = readFileSync(absPath, "utf8");
  const parsed = parseNote(raw);

  const lines = parsed.body.split(/\r\n|\n/);
  let newBody: string;

  if (args.heading) {
    const idx = parsed.headings.findIndex((h) => h.text.trim().toLowerCase() === args.heading!.trim().toLowerCase());
    if (idx === -1) {
      return `Error: heading "${args.heading}" not found in ${file.path}. Nothing was written.`;
    }
    const target = parsed.headings[idx]!;
    let endLine = lines.length + 1;
    for (let i = idx + 1; i < parsed.headings.length; i++) {
      if (parsed.headings[i]!.level <= target.level) {
        endLine = parsed.headings[i]!.line;
        break;
      }
    }
    const insertionIndex = endLine - 1;
    const before = lines.slice(0, insertionIndex);
    const after = lines.slice(insertionIndex);
    newBody = [...before, "", args.content.trimEnd(), "", ...after].join("\n");
  } else {
    newBody = `${parsed.body.replace(/\s+$/, "")}\n\n${args.content.trimEnd()}\n`;
  }
  newBody = newBody.replace(/\n{3,}/g, "\n\n");

  const fileText = Object.keys(parsed.frontmatter).length > 0 ? matter.stringify(newBody, parsed.frontmatter) : newBody;
  writeFileSync(absPath, fileText, "utf8");
  engine.indexFileNow(file.path);

  return `Appended to ${file.path}${args.heading ? ` under heading "${args.heading}"` : ""}.\n\n${readNote(engine, { path: file.path })}`;
}
