import { existsSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import { MAX_INLINE_IMAGE_BYTES, isImagePath } from "../attachments/extract.js";
import type { FileRow } from "../index/db.js";
import { EMBEDDING_MODEL, bufferToVector, cosineSimilarity } from "../index/embeddings.js";
import { parseNote } from "../parser/markdown.js";
import { resolveLink } from "../vault/resolve.js";
import { basenameNoExt, resolveExistingVaultPath, toSafeVaultRelPath } from "../vault/paths.js";
import { writeFileAtomic } from "../vault/write.js";
import type { VaultEngine } from "../vault-engine.js";
import { estimateTokens, extractSection, firstParagraph, formatFrontmatter, truncateToTokens } from "./format.js";

/** Resolve a user-supplied note reference (path, alias, or bare title) using the same semantics as in-vault links. */
export function resolveNoteArg(engine: VaultEngine, input: string): FileRow | undefined {
  // The DB stores Unicode-NFC-normalized paths regardless of how a file's
  // name bytes ended up on disk (see index/scan.ts); normalize the caller's
  // input the same way so e.g. a JSON client sending NFC-composed Korean
  // text still matches a note whose filename was originally written as NFD.
  const normalized = input.normalize("NFC");
  const direct = engine.db.getFileByPath(normalized) ?? engine.db.getFileByPath(`${normalized}.md`);
  if (direct) return direct;
  const index = engine.db.buildResolverIndex();
  const resolved = resolveLink(normalized, index);
  return resolved ? engine.db.getFileByPath(resolved.path) : undefined;
}

/** Resolve any indexed vault file, including attachments. */
export function resolveFileArg(engine: VaultEngine, input: string): FileRow | undefined {
  return resolveNoteArg(engine, input);
}

export function vaultOverview(engine: VaultEngine): string {
  const status = engine.getStatus();
  const files = engine.db.getAllFiles();
  const mdFiles = files.filter((f) => f.is_markdown === 1);
  const attachmentCount = files.length - mdFiles.length;
  const tagCounts = engine.db.getAllTagCounts().slice(0, 10);
  const hubs = engine.graph.pagerank().slice(0, 5);
  const recent = [...mdFiles].sort((a, b) => b.mtime - a.mtime).slice(0, 5);

  const lines: string[] = [
    "# Vault Overview",
    "",
    `- **Vault state**: ${status.mountState}${status.stale ? " (indexed reads may be stale; writes are blocked)" : ""}`,
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

export function vaultStatus(engine: VaultEngine): string {
  const status = engine.getStatus();
  return [
    "# Vault Status",
    "",
    `- **Mount guard**: ${status.mountGuardEnabled ? "enabled (beta)" : "disabled"}`,
    `- **State**: ${status.mountState}`,
    `- **Indexed content**: ${status.indexedNotes} notes, ${status.indexedAttachments} attachments`,
    `- **Index may be stale**: ${status.stale ? "yes" : "no"}`,
    `- **Writes allowed**: ${status.writesAllowed ? "yes" : "no"}`,
    `- **Sentinel**: ${status.mountSentinel ?? "none (non-empty listing fallback)"}`,
    `- **Last full reconciliation**: ${status.lastReconciledAt ?? "not yet"}`,
  ].join("\n");
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
    candidates = hits
      .map((h) => engine.db.getFileByPath(h.path))
      .filter((f): f is FileRow => f !== undefined && f.is_markdown === 1);
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

/** Notes embedded per semantic tool call before returning, bounding how much one request can add to a large backlog's latency. */
const EMBEDDING_BATCH_LIMIT = 50;

export interface SemanticSearchArgs {
  query: string;
  limit?: number;
  folder?: string;
}

/** Meaning-based search via embedding cosine similarity -- finds conceptually related notes that don't share the query's exact words, unlike search_notes' FTS5 matching. */
export async function semanticSearch(engine: VaultEngine, args: SemanticSearchArgs): Promise<string> {
  const query = args.query?.trim();
  if (!query) return "Error: query must not be empty.";
  if (!engine.semanticSearchEnabled) {
    return "Semantic search is disabled in low-memory mode. Set OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC=true and restart the server to opt in (the bundled multilingual model may use more than 500 MiB RSS).";
  }
  const limit = args.limit ?? 10;
  const folder = args.folder?.replace(/^\/+|\/+$/g, "");

  const { embedded, remaining } = await engine.ensureEmbeddingsFresh(EMBEDDING_BATCH_LIMIT);
  const queryVector = await engine.embedQuery(query);
  const scored = engine.db
    .getAllEmbeddings(EMBEDDING_MODEL)
    .map((row) => ({ fileId: row.fileId, score: cosineSimilarity(queryVector, bufferToVector(row.vector)) }))
    .sort((a, b) => b.score - a.score);

  const results: { file: FileRow; score: number }[] = [];
  for (const { fileId, score } of scored) {
    if (results.length >= limit) break;
    const file = engine.db.getFileById(fileId);
    if (!file) continue;
    if (folder && !file.path.startsWith(`${folder}/`)) continue;
    results.push({ file, score });
  }

  const lines = [`# Semantic Search Results (${results.length})`, ""];
  if (remaining > 0) {
    lines.push(
      `_${remaining} note(s) not yet embedded (embedded ${embedded} just now); results may be incomplete. Call again to index more._`,
      "",
    );
  }
  if (results.length === 0) {
    lines.push("_No semantically similar notes found._");
    return lines.join("\n");
  }
  for (const { file, score } of results) {
    lines.push(`## [[${file.path}]]${file.title ? ` — ${file.title}` : ""} (similarity ${score.toFixed(3)})`);
  }
  return lines.join("\n");
}

export interface ListNotesArgs {
  folder?: string;
  recursive?: boolean;
  offset?: number;
  limit?: number;
  properties?: string[];
}

function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? value.map((v) => String(v)).join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function listFolder(engine: VaultEngine, args: { folder?: string }): string {
  const folder = args.folder?.replace(/^\/+|\/+$/g, "") ?? "";
  const prefix = folder ? `${folder}/` : "";
  const folders = new Set<string>();
  const files: FileRow[] = [];
  for (const file of engine.db.getAllFiles()) {
    if (!file.path.startsWith(prefix)) continue;
    const remainder = file.path.slice(prefix.length);
    if (!remainder) continue;
    const slash = remainder.indexOf("/");
    if (slash === -1) files.push(file);
    else folders.add(remainder.slice(0, slash));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (!folders.size && !files.length) return `Folder not found or empty: ${folder || "/"}`;
  const folderLines = [...folders].sort().map((name) => `- ${prefix}${name}/`);
  return [
    `# Folder: ${folder || "/"}`,
    "",
    "## Folders",
    ...(folderLines.length ? folderLines : ["_none_"]),
    "",
    "## Files",
    ...(files.length
      ? files.map((file) => `- ${file.path}${file.is_markdown === 1 ? " (note)" : " (attachment)"}`)
      : ["_none_"]),
  ].join("\n");
}

export interface SearchFilesArgs {
  query?: string;
  folder?: string;
  extension?: string;
  limit?: number;
}

/** Full-text search over extracted attachment content (PDF/Office/text/etc.). */
export async function searchFiles(engine: VaultEngine, args: SearchFilesArgs): Promise<string> {
  const limit = args.limit ?? 10;
  // Sequential, bounded extraction keeps one search call from turning into a
  // memory/latency spike on a large vault. Repeated calls drain the backlog.
  const extraction = await engine.ensureAttachmentExtractionsFresh(10);
  const folder = args.folder?.replace(/^\/+|\/+$/g, "");
  const extension = args.extension?.replace(/^\./, "").toLowerCase();
  const query = args.query?.trim();
  const hits = query ? engine.db.search(query, Math.max(limit * 5, 50)) : [];
  const snippets = new Map(hits.map((hit) => [hit.path, hit.snippet]));
  let files = query
    ? hits.map((hit) => engine.db.getFileByPath(hit.path)).filter((file): file is FileRow => Boolean(file))
    : engine.db.getAllFiles();
  files = files
    .filter((file) => file.is_markdown === 0)
    .filter((file) => !folder || file.path.startsWith(`${folder}/`))
    .filter((file) => !extension || file.path.toLowerCase().endsWith(`.${extension}`))
    .slice(0, limit);

  const lines = [`# File Search Results (${files.length})`, ""];
  if (extraction.remaining > 0) {
    lines.push(
      `_${extraction.remaining} attachment(s) still await extraction (processed ${extraction.extracted} now); call again for a complete vault-wide search._`,
      "",
    );
  }
  if (!files.length) {
    lines.push("_No matching files found._");
    return lines.join("\n");
  }
  for (const file of files) {
    const cached = engine.db.getAttachmentExtraction(file.id);
    lines.push(`## [[${file.path}]]`);
    lines.push(`- **Type**: ${cached?.mime_type ?? "not extracted"}`);
    lines.push(`- **Status**: ${cached?.status ?? "pending"}`);
    const snippet = snippets.get(file.path);
    if (snippet) lines.push(`- **Match**: ${snippet}`);
    if (cached?.error) lines.push(`- **Note**: ${cached.error}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export interface ReadFileArgs {
  path: string;
  page?: number;
  slide?: number;
  sheet?: string;
  offset?: number;
  limit?: number;
}

export interface ReadFileResult {
  text: string;
  image?: { data: string; mimeType: string };
  error?: string;
}

function markedSection(text: string, marker: string): string | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^## ${escaped}\\s*\\n([\\s\\S]*?)(?=^## |$)`, "m"));
  return match?.[1]?.trim() ?? null;
}

/** Read a Markdown note or any indexed attachment through one safe vault-relative API. */
export async function readFile(engine: VaultEngine, args: ReadFileArgs): Promise<ReadFileResult> {
  const file = resolveFileArg(engine, args.path);
  if (!file) return { text: `File not found: ${args.path}`, error: `File not found: ${args.path}` };
  if (file.is_markdown === 1) return { text: readNote(engine, args) };

  const extraction = await engine.ensureAttachmentExtracted(file.id);
  if (!extraction) return { text: `File not found: ${args.path}`, error: `File not found: ${args.path}` };
  const backlinks = engine.db.getBacklinks(file.path);
  const metadata = Object.entries(extraction.metadata)
    .map(([key, value]) => `- **${key}**: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join("\n");
  const header = [
    `# ${file.path}`,
    "",
    `- **MIME type**: ${extraction.mimeType}`,
    `- **Status**: ${extraction.status}`,
    `- **Modified**: ${new Date(file.mtime).toISOString()}`,
    `- **Referenced by (${backlinks.length})**: ${backlinks.length ? backlinks.map((row) => `[[${row.sourcePath}]]`).join(", ") : "_none_"}`,
    ...(metadata ? [metadata] : []),
    ...(extraction.error ? [`- **Note**: ${extraction.error}`] : []),
  ];

  if (isImagePath(file.path)) {
    const absPath = resolveExistingVaultPath(engine.vaultDir, file.path);
    const image = readFileSync(absPath);
    if (image.length > MAX_INLINE_IMAGE_BYTES) {
      return {
        text: [
          ...header,
          "",
          `Image is too large to inline (${image.length} bytes; limit ${MAX_INLINE_IMAGE_BYTES}).`,
        ].join("\n"),
      };
    }
    return { text: header.join("\n"), image: { data: image.toString("base64"), mimeType: extraction.mimeType } };
  }

  if (!extraction.text) {
    return {
      text: [...header, "", extraction.error ?? "No readable text was extracted from this binary file."].join("\n"),
    };
  }

  let selected = extraction.text;
  let selector: string | undefined;
  if (args.page !== undefined) selector = `Page ${args.page}`;
  else if (args.slide !== undefined) selector = `Slide ${args.slide}`;
  else if (args.sheet !== undefined) selector = `Sheet: ${args.sheet}`;
  if (selector) {
    const section = markedSection(selected, selector);
    if (section === null)
      return {
        text: [...header, "", `Section not found: ${selector}`].join("\n"),
        error: `Section not found: ${selector}`,
      };
    selected = section;
  }

  const lines = selected.split(/\r?\n/);
  const offset = Math.min(args.offset ?? 0, lines.length);
  const limit = args.limit ?? 500;
  const page = lines.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  header.push(
    `- **Text page**: lines ${offset + 1}-${nextOffset} of ${lines.length}${nextOffset < lines.length ? `; continue with offset ${nextOffset}` : ""}`,
  );
  return { text: [...header, "", "---", "", page.join("\n")].join("\n") };
}

export interface NoteListData {
  notes: {
    path: string;
    title: string | null;
    mtime: string;
    tags: string[];
    properties?: Record<string, unknown>;
  }[];
  folders: string[];
  pagination: { offset: number; limit: number; total: number; hasMore: boolean; nextOffset: number | null };
}

export function listNotesData(engine: VaultEngine, args: ListNotesArgs): NoteListData {
  const folder = args.folder?.replace(/^\/+|\/+$/g, "") ?? "";
  const prefix = folder ? `${folder}/` : "";
  const recursive = args.recursive ?? true;
  const matching = engine.db
    .getAllFiles()
    .filter((file) => file.is_markdown === 1 && file.path.startsWith(prefix))
    .filter((file) => recursive || !file.path.slice(prefix.length).includes("/"))
    .sort((a, b) => a.path.localeCompare(b.path));
  const folders = new Set<string>();
  for (const file of engine.db.getAllFiles()) {
    if (!file.path.startsWith(prefix)) continue;
    const remainder = file.path.slice(prefix.length);
    const first = remainder.split("/")[0];
    if (first && remainder.includes("/")) folders.add(prefix + first);
  }
  const offset = Math.min(args.offset ?? 0, matching.length);
  const limit = args.limit ?? 100;
  const page = matching.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const properties = args.properties?.filter((key) => key.trim().length > 0);
  return {
    notes: page.map((file) => {
      const note: NoteListData["notes"][number] = {
        path: file.path,
        title: file.title,
        mtime: new Date(file.mtime).toISOString(),
        tags: engine.db.getTagsForFile(file.id).map((tag) => tag.tag),
      };
      if (properties?.length) {
        let frontmatter: Record<string, unknown> = {};
        if (file.frontmatter_json) {
          try {
            frontmatter = JSON.parse(file.frontmatter_json) as Record<string, unknown>;
          } catch {
            frontmatter = {};
          }
        }
        note.properties = Object.fromEntries(properties.map((key) => [key, frontmatter[key] ?? null]));
      }
      return note;
    }),
    folders: [...folders].sort(),
    pagination: {
      offset,
      limit,
      total: matching.length,
      hasMore: nextOffset < matching.length,
      nextOffset: nextOffset < matching.length ? nextOffset : null,
    },
  };
}

export function listNotes(engine: VaultEngine, args: ListNotesArgs): string {
  const data = listNotesData(engine, args);
  const lines = [
    `# Notes (${data.notes.length}/${data.pagination.total})`,
    "",
    ...(data.folders.length ? ["## Folders", ...data.folders.map((folder) => `- ${folder}/`), ""] : []),
    "## Notes",
    ...(data.notes.length
      ? data.notes.map((note) => {
          const propsStr = note.properties
            ? ` — ${Object.entries(note.properties)
                .map(([key, value]) => `${key}: ${formatPropertyValue(value)}`)
                .join(", ")}`
            : "";
          return `- [[${note.path}]]${propsStr}`;
        })
      : ["_none_"]),
  ];
  if (data.pagination.hasMore) lines.push("", `Continue with offset ${data.pagination.nextOffset}.`);
  return lines.join("\n");
}

export interface RegexSearchArgs {
  pattern: string;
  folder?: string;
  flags?: string;
  limit?: number;
}

export function regexSearch(engine: VaultEngine, args: RegexSearchArgs): string {
  if (!args.pattern || args.pattern.length > 500) return "Error: pattern must be 1-500 characters.";
  let regex: RegExp;
  try {
    const flags = args.flags ?? "i";
    if (/[^imsu]/.test(flags)) return "Error: flags may only contain i, m, s, and u.";
    regex = new RegExp(args.pattern, flags.replace(/g/g, ""));
  } catch (err) {
    return `Error: invalid regular expression: ${(err as Error).message}`;
  }
  const folder = args.folder?.replace(/^\/+|\/+$/g, "");
  const limit = args.limit ?? 50;
  const results: { path: string; line: number; text: string }[] = [];
  for (const file of engine.db
    .getAllFiles()
    .filter((row) => row.is_markdown === 1)
    .sort((a, b) => a.path.localeCompare(b.path))) {
    if (folder && !file.path.startsWith(`${folder}/`)) continue;
    const lines = (file.raw_content ?? "").split(/\r\n|\n/);
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i] ?? "")) {
        results.push({ path: file.path, line: i + 1, text: (lines[i] ?? "").trim().slice(0, 300) });
        if (results.length >= limit) break;
      }
    }
    if (results.length >= limit) break;
  }
  if (!results.length) return "No regex matches found.";
  return [
    `# Regex Search Results (${results.length})`,
    "",
    ...results.map((r) => `- [[${r.path}]]:${r.line} — ${r.text}`),
  ].join("\n");
}

export interface ReadNoteArgs {
  path: string;
  heading?: string;
  /** Zero-based line offset within the full note or selected heading. */
  offset?: number;
  /** Maximum number of lines to return. Defaults to 500. */
  limit?: number;
}

export interface ReadNoteData {
  path: string;
  title: string | null;
  content: string;
  frontmatter: Record<string, unknown>;
  outlinks: { target: string; resolvedPath: string | null; type: string; line: number | null }[];
  backlinks: { sourcePath: string; type: string; line: number | null; context: string | null }[];
  tags: string[];
  pagination: {
    offset: number;
    limit: number;
    returnedLines: number;
    totalLines: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
  heading?: string;
  warning?: string;
}

function parseFrontmatterJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readNoteData(engine: VaultEngine, args: ReadNoteArgs): ReadNoteData | { error: string } {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return { error: `Note not found: ${args.path}` };

  const outlinks = engine.db.getOutlinks(file.path);
  const backlinks = engine.db.getBacklinks(file.path);
  const tags = engine.db.getTagsForFile(file.id).map((t) => t.tag);

  const body = file.raw_content ?? "";
  let selectedBody = body;
  let warning: string | undefined;
  if (args.heading) {
    const headings = engine.db.getHeadingsForFile(file.id);
    const section = extractSection(body, headings, args.heading);
    if (section === null) warning = `Heading "${args.heading}" not found; showing the full note.`;
    else selectedBody = section;
  }

  const allLines = selectedBody.split(/\r\n|\n/);
  const offset = Math.min(args.offset ?? 0, allLines.length);
  const limit = args.limit ?? 500;
  const pageLines = allLines.slice(offset, offset + limit);
  const nextOffset = offset + pageLines.length;
  const hasMore = nextOffset < allLines.length;

  return {
    path: file.path,
    title: file.title,
    content: pageLines.join("\n"),
    frontmatter: parseFrontmatterJson(file.frontmatter_json),
    outlinks: outlinks.map((link) => ({
      target: link.targetRaw,
      resolvedPath: link.targetPath,
      type: link.type,
      line: link.line,
    })),
    backlinks: backlinks.map((link) => ({
      sourcePath: link.sourcePath,
      type: link.type,
      line: link.line,
      context: link.context,
    })),
    tags,
    pagination: {
      offset,
      limit,
      returnedLines: pageLines.length,
      totalLines: allLines.length,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
    },
    ...(args.heading ? { heading: args.heading } : {}),
    ...(warning ? { warning } : {}),
  };
}

export function readNote(engine: VaultEngine, args: ReadNoteArgs): string {
  const data = readNoteData(engine, args);
  if ("error" in data) return data.error;
  const frontmatter = Object.keys(data.frontmatter).length ? formatFrontmatter(JSON.stringify(data.frontmatter)) : "";

  const lines: string[] = [
    `# ${data.title ?? data.path}`,
    `*${data.path}*`,
    "",
    "## Graph Context",
    `- **Outlinks (${data.outlinks.length})**: ${data.outlinks.length ? data.outlinks.map((l) => (l.resolvedPath ? `[[${l.resolvedPath}]]` : `${l.target} (unresolved)`)).join(", ") : "_none_"}`,
    `- **Backlinks (${data.backlinks.length})**: ${data.backlinks.length ? data.backlinks.map((b) => `[[${b.sourcePath}]]`).join(", ") : "_none_"}`,
    `- **Tags**: ${data.tags.length ? data.tags.map((tag) => `#${tag}`).join(" ") : "_none_"}`,
    ...(frontmatter ? ["- **Frontmatter**:", frontmatter] : []),
    ...(data.warning ? [`- **Warning**: ${data.warning}`] : []),
    `- **Page**: lines ${data.pagination.offset + 1}-${data.pagination.offset + data.pagination.returnedLines} of ${data.pagination.totalLines}${data.pagination.hasMore ? `; continue with offset ${data.pagination.nextOffset}` : ""}`,
    "",
    "---",
    "",
    data.content,
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
  method?: "jaccard" | "semantic";
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

/**
 * Similar notes via embedding cosine similarity -- note.method === "semantic"
 * uses this as an alternative to (not blended with) the default Jaccard
 * method, rather than combining the two into one score: DECISIONS.md D13
 * already rejected blending two signals with an arbitrary weight, and a
 * third (semantic) signal would face the same objection. An explicit
 * caller-chosen method sidesteps that without changing the default.
 */
async function getRelatedSemantic(engine: VaultEngine, file: FileRow, limit: number): Promise<string> {
  if (!engine.semanticSearchEnabled) {
    return `# Related to ${file.path}\n\n_Semantic similarity is disabled in low-memory mode. Set OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC=true and restart the server to opt in (the bundled multilingual model may use more than 500 MiB RSS). Use the default Jaccard method for a lightweight alternative._`;
  }
  await engine.ensureEmbeddingsFresh(EMBEDDING_BATCH_LIMIT);
  const ownEmbedding = engine.db.getEmbedding(file.id, EMBEDDING_MODEL);
  if (!ownEmbedding) {
    return `# Related to ${file.path}\n\n_This note's embedding isn't ready yet (embedding runs incrementally) — try again._`;
  }
  const ownVector = bufferToVector(ownEmbedding);
  const scored = engine.db
    .getAllEmbeddings(EMBEDDING_MODEL)
    .filter((row) => row.fileId !== file.id)
    .map((row) => ({ fileId: row.fileId, score: cosineSimilarity(ownVector, bufferToVector(row.vector)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) {
    return `# Related to ${file.path}\n\n_No semantically similar notes found._`;
  }
  const lines = [
    `# Related to ${file.path}`,
    "",
    "_Similar by embedding similarity (multilingual-e5-small), not shared tags/links:_",
    "",
  ];
  for (const { fileId, score } of scored) {
    const f = engine.db.getFileById(fileId);
    if (!f) continue;
    lines.push(`- [[${f.path}]]${f.title ? ` — ${f.title}` : ""} (similarity ${score.toFixed(3)})`);
  }
  return lines.join("\n");
}

/** Similar notes via Jaccard similarity of {shared tags} ∪ {shared 1-hop neighbors} — deliberately not requiring a direct link. */
export async function getRelated(engine: VaultEngine, args: GetRelatedArgs): Promise<string> {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Note not found: ${args.path}`;
  const limit = args.limit ?? 5;

  if (args.method === "semantic") return getRelatedSemantic(engine, file, limit);

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
    // Resolves to the real on-disk file when overwriting an existing note
    // that happens to be named in a different Unicode normalization form
    // than `relPath` (see resolveExistingVaultPath) — falls back to the
    // plain (NFC) target path when nothing exists yet, i.e. a genuine create.
    absPath = resolveExistingVaultPath(engine.vaultDir, relPath);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  // Check the DB (Unicode-NFC-normalized identity, see index/scan.ts) in
  // addition to a raw filesystem check: on a filesystem that doesn't unify
  // NFC/NFD itself (some external exFAT/FAT32 drives), an existing note
  // originally written in NFD could otherwise be invisible to existsSync()
  // on the caller's NFC path, and get silently duplicated as a second,
  // byte-different file instead of being reported as already existing.
  if ((existsSync(absPath) || engine.db.getFileByPath(relPath)) && !args.overwrite) {
    return `Error: ${relPath} already exists. Pass overwrite: true to replace it, or use append_to_note to add to it.`;
  }

  const body = args.content ?? "";
  const fileText =
    args.frontmatter && Object.keys(args.frontmatter).length > 0 ? matter.stringify(body, args.frontmatter) : body;

  try {
    writeFileAtomic(absPath, fileText);
    engine.indexFileNow(relPath);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  return `Created ${relPath}.\n\n${readNote(engine, { path: relPath })}`;
}

const DATE_FORMAT_TOKEN_RE = /YYYY|YY|MM|DD|HH|mm|ss/g;

/** A small, dependency-free subset of moment.js format tokens -- enough for the day/time formats real daily-note templates use, without pulling in moment.js for this alone. */
function formatDateToken(date: Date, format: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    YY: String(date.getFullYear()).slice(-2),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  return format.replace(DATE_FORMAT_TOKEN_RE, (m) => tokens[m] ?? m);
}

/**
 * Obsidian's core Templates plugin variable set -- {{date}}, {{date:FORMAT}},
 * {{time}}, {{time:FORMAT}}, {{title}} -- applied to the raw template text
 * before it's ever parsed as frontmatter+body, matching how Obsidian itself
 * renders a template. Templater-only syntax (<% tp... %>) isn't supported;
 * it's passed through as literal text rather than guessed at.
 */
function renderTemplate(raw: string, title: string, now: Date): string {
  return raw
    .replace(/\{\{date(?::([^}]+))?\}\}/g, (_m, fmt: string | undefined) => formatDateToken(now, fmt ?? "YYYY-MM-DD"))
    .replace(/\{\{time(?::([^}]+))?\}\}/g, (_m, fmt: string | undefined) => formatDateToken(now, fmt ?? "HH:mm"))
    .replaceAll("{{title}}", title);
}

export interface ApplyTemplateArgs {
  template: string;
  path: string;
  frontmatter?: Record<string, unknown>;
  overwrite?: boolean;
}

export function applyTemplate(engine: VaultEngine, args: ApplyTemplateArgs): string {
  const templateFile = resolveNoteArg(engine, args.template);
  if (!templateFile) return `Error: template not found: ${args.template}`;

  let relPath: string;
  let absPath: string;
  try {
    relPath = toSafeVaultRelPath(args.path);
    relPath = engine.db.getFileByPath(relPath)?.path ?? relPath;
    absPath = resolveExistingVaultPath(engine.vaultDir, relPath);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  if ((existsSync(absPath) || engine.db.getFileByPath(relPath)) && !args.overwrite) {
    return `Error: ${relPath} already exists. Pass overwrite: true to replace it, or use append_to_note to add to it.`;
  }

  const templateRaw = readFileSync(resolveExistingVaultPath(engine.vaultDir, templateFile.path), "utf8");
  const rendered = renderTemplate(templateRaw, basenameNoExt(relPath), new Date());

  let fileText = rendered;
  if (args.frontmatter && Object.keys(args.frontmatter).length > 0) {
    const parsed = parseNote(rendered);
    fileText = matter.stringify(parsed.body, { ...parsed.frontmatter, ...args.frontmatter });
  }

  try {
    writeFileAtomic(absPath, fileText);
    engine.indexFileNow(relPath);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
  return `Created ${relPath} from template ${templateFile.path}.\n\n${readNote(engine, { path: relPath })}`;
}

export interface AppendToNoteArgs {
  path: string;
  content: string;
  heading?: string;
}

export function appendToNote(engine: VaultEngine, args: AppendToNoteArgs): string {
  const file = resolveNoteArg(engine, args.path);
  if (!file) return `Error: note not found: ${args.path}. Use create_note to make a new one.`;

  const absPath = resolveExistingVaultPath(engine.vaultDir, file.path);
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
  try {
    writeFileAtomic(absPath, fileText);
    engine.indexFileNow(file.path);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  return `Appended to ${file.path}${args.heading ? ` under heading "${args.heading}"` : ""}.\n\n${readNote(engine, { path: file.path })}`;
}
