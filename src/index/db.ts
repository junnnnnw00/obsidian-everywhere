import Database from "better-sqlite3";
import type { ParsedBlock, ParsedHeading, ParsedLink, ParsedTag } from "../parser/types.js";
import { buildResolverIndex, resolveLink, type ResolvableFile, type ResolverIndex } from "../vault/resolve.js";
import { SCHEMA_SQL } from "./schema.js";

export interface FileRow {
  id: number;
  path: string;
  title: string | null;
  is_markdown: number;
  mtime: number;
  hash: string;
  frontmatter_json: string | null;
  raw_content: string | null;
  updated_at: number;
}

export interface FileMetaInput {
  path: string;
  isMarkdown: boolean;
  mtime: number;
  hash: string;
  title: string | null;
  frontmatterJson: string | null;
  rawContent: string | null;
}

export interface LinkChange {
  linkId: number;
  sourceId: number;
  oldTargetId: number | null;
  newTargetId: number | null;
}

export interface BacklinkRow {
  sourcePath: string;
  sourceTitle: string | null;
  type: string;
  line: number | null;
  context: string | null;
}

export interface AttachmentExtractionRow {
  file_id: number;
  source_hash: string;
  extractor_version: string;
  status: "extracted" | "image" | "unsupported" | "error";
  mime_type: string;
  text_content: string | null;
  metadata_json: string;
  error: string | null;
  updated_at: number;
}

export interface SearchFilter {
  isMarkdown?: boolean;
  folderPrefix?: string;
  extensionSuffix?: string;
}

type SearchRow = { path: string; title: string | null; snippet: string };

export class VaultDB {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.backfillTrigramIndexIfNeeded();
  }

  /**
   * files_fts_trigram (see schema.ts) was added after files_fts; on an
   * existing index database it starts out empty, and fullScan's mtime+hash
   * gating means unchanged files would never repopulate it on their own.
   * Cheap no-op once populated (a COUNT(*) that short-circuits).
   */
  private backfillTrigramIndexIfNeeded(): void {
    const { count } = this.db.prepare("SELECT COUNT(*) as count FROM files_fts_trigram").get() as { count: number };
    if (count > 0) return;
    const { fileCount } = this.db.prepare("SELECT COUNT(*) as fileCount FROM files").get() as { fileCount: number };
    if (fileCount === 0) return;
    this.db.exec(
      "INSERT INTO files_fts_trigram (rowid, path, title, content) SELECT id, path, title, COALESCE(raw_content, '') FROM files",
    );
  }

  close(): void {
    this.db.close();
  }

  /**
   * Runs `fn` (must be synchronous) inside a SQLite transaction: if it
   * throws partway through, every write it made is rolled back, leaving
   * the DB exactly as it was before. fullScan needs this -- it writes each
   * file's content in one pass and every file's links in a second, later
   * pass, so a crash between those two passes previously left affected
   * files with content but no links, and the mtime+hash "unchanged"
   * short-circuit meant no later scan would ever notice or repair it
   * (see DECISIONS.md D21).
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- file CRUD -----------------------------------------------------

  getFileByPath(path: string): FileRow | undefined {
    return this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as FileRow | undefined;
  }

  getFileById(id: number): FileRow | undefined {
    return this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow | undefined;
  }

  getAllFiles(): FileRow[] {
    return this.db.prepare("SELECT * FROM files").all() as FileRow[];
  }

  getAttachmentExtraction(fileId: number): AttachmentExtractionRow | undefined {
    return this.db.prepare("SELECT * FROM attachment_extractions WHERE file_id = ?").get(fileId) as
      AttachmentExtractionRow | undefined;
  }

  getFilesNeedingAttachmentExtraction(extractorVersion: string, limit: number): FileRow[] {
    return this.db
      .prepare(
        `SELECT f.* FROM files f
         LEFT JOIN attachment_extractions a ON a.file_id = f.id
         WHERE f.is_markdown = 0
           AND (a.file_id IS NULL OR a.source_hash != f.hash OR a.extractor_version != ?)
         ORDER BY f.id
         LIMIT ?`,
      )
      .all(extractorVersion, limit) as FileRow[];
  }

  countFilesNeedingAttachmentExtraction(extractorVersion: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM files f
         LEFT JOIN attachment_extractions a ON a.file_id = f.id
         WHERE f.is_markdown = 0
           AND (a.file_id IS NULL OR a.source_hash != f.hash OR a.extractor_version != ?)`,
      )
      .get(extractorVersion) as { count: number };
    return row.count;
  }

  upsertAttachmentExtraction(
    file: FileRow,
    extractorVersion: string,
    extraction: {
      status: AttachmentExtractionRow["status"];
      mimeType: string;
      text: string | null;
      metadata: Record<string, unknown>;
      error: string | null;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO attachment_extractions
           (file_id, source_hash, extractor_version, status, mime_type, text_content, metadata_json, error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET
           source_hash=excluded.source_hash,
           extractor_version=excluded.extractor_version,
           status=excluded.status,
           mime_type=excluded.mime_type,
           text_content=excluded.text_content,
           metadata_json=excluded.metadata_json,
           error=excluded.error,
           updated_at=excluded.updated_at`,
      )
      .run(
        file.id,
        file.hash,
        extractorVersion,
        extraction.status,
        extraction.mimeType,
        extraction.text,
        JSON.stringify(extraction.metadata),
        extraction.error,
        Date.now(),
      );
    this.upsertFts(file.id, file.path, file.title, extraction.text);
  }

  getFileCounts(): { markdown: number; attachments: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN is_markdown = 1 THEN 1 ELSE 0 END), 0) AS markdown
         FROM files`,
      )
      .get() as { total: number; markdown: number };
    return { markdown: row.markdown, attachments: row.total - row.markdown };
  }

  upsertFileMeta(meta: FileMetaInput): number {
    const now = Date.now();
    const existing = this.getFileByPath(meta.path);
    if (existing) {
      this.db
        .prepare(
          `UPDATE files SET title=?, is_markdown=?, mtime=?, hash=?, frontmatter_json=?, raw_content=?, updated_at=? WHERE id=?`,
        )
        .run(
          meta.title,
          meta.isMarkdown ? 1 : 0,
          meta.mtime,
          meta.hash,
          meta.frontmatterJson,
          meta.rawContent,
          now,
          existing.id,
        );
      this.upsertFts(existing.id, meta.path, meta.title, meta.rawContent);
      return existing.id;
    }
    const info = this.db
      .prepare(
        `INSERT INTO files (path, title, is_markdown, mtime, hash, frontmatter_json, raw_content, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET
           title=excluded.title,
           is_markdown=excluded.is_markdown,
           mtime=excluded.mtime,
           hash=excluded.hash,
           frontmatter_json=excluded.frontmatter_json,
           raw_content=excluded.raw_content,
           updated_at=excluded.updated_at`,
      )
      .run(
        meta.path,
        meta.title,
        meta.isMarkdown ? 1 : 0,
        meta.mtime,
        meta.hash,
        meta.frontmatterJson,
        meta.rawContent,
        now,
      );
    const id = Number(info.lastInsertRowid) || (this.getFileByPath(meta.path)?.id ?? 0);
    this.upsertFts(id, meta.path, meta.title, meta.rawContent);
    return id;
  }

  deleteFileByPath(path: string): number | null {
    const existing = this.getFileByPath(path);
    if (!existing) return null;
    this.db.prepare("DELETE FROM files_fts WHERE rowid = ?").run(existing.id);
    this.db.prepare("DELETE FROM files_fts_trigram WHERE rowid = ?").run(existing.id);
    this.db.prepare("DELETE FROM files WHERE id = ?").run(existing.id);
    return existing.id;
  }

  private upsertFts(id: number, path: string, title: string | null, content: string | null): void {
    if (!id) return;
    this.db.prepare("DELETE FROM files_fts WHERE rowid = ?").run(id);
    this.db
      .prepare("INSERT OR REPLACE INTO files_fts (rowid, path, title, content) VALUES (?,?,?,?)")
      .run(id, path, title ?? "", content ?? "");
    this.db.prepare("DELETE FROM files_fts_trigram WHERE rowid = ?").run(id);
    this.db
      .prepare("INSERT OR REPLACE INTO files_fts_trigram (rowid, path, title, content) VALUES (?,?,?,?)")
      .run(id, path, title ?? "", content ?? "");
    // upsertFileMeta only ever calls upsertFts when a file is new or its
    // content actually changed (scan.ts short-circuits unchanged hashes
    // before reaching here), so an existing embedding is now stale.
    // ensureEmbeddingsFresh's "missing embedding" query re-picks it up.
    this.db.prepare("DELETE FROM embeddings WHERE file_id = ?").run(id);
  }

  // --- derived data (links/tags/aliases/headings/blocks) -------------

  replaceAliases(fileId: number, aliases: string[]): void {
    this.db.prepare("DELETE FROM aliases WHERE file_id = ?").run(fileId);
    const stmt = this.db.prepare("INSERT INTO aliases (file_id, alias) VALUES (?,?)");
    for (const alias of aliases) stmt.run(fileId, alias);
  }

  replaceTags(fileId: number, tags: ParsedTag[]): void {
    this.db.prepare("DELETE FROM tags WHERE file_id = ?").run(fileId);
    const stmt = this.db.prepare("INSERT INTO tags (file_id, tag, source, line) VALUES (?,?,?,?)");
    for (const t of tags) stmt.run(fileId, t.tag, t.source, t.line ?? null);
  }

  replaceHeadings(fileId: number, headings: ParsedHeading[]): void {
    this.db.prepare("DELETE FROM headings WHERE file_id = ?").run(fileId);
    const stmt = this.db.prepare("INSERT INTO headings (file_id, level, text, line) VALUES (?,?,?,?)");
    for (const h of headings) stmt.run(fileId, h.level, h.text, h.line);
  }

  replaceBlocks(fileId: number, blocks: ParsedBlock[]): void {
    this.db.prepare("DELETE FROM blocks WHERE file_id = ?").run(fileId);
    const stmt = this.db.prepare("INSERT INTO blocks (file_id, block_id, line) VALUES (?,?,?)");
    for (const b of blocks) stmt.run(fileId, b.blockId, b.line);
  }

  /** Replace all outgoing links for a file, resolving each target against the current resolver index. */
  replaceLinks(fileId: number, links: ParsedLink[], resolverIndex: ResolverIndex): void {
    this.db.prepare("DELETE FROM links WHERE source_id = ?").run(fileId);
    const stmt = this.db.prepare(
      `INSERT INTO links (source_id, target_raw, target_id, type, heading, block_id, alias, line, context) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const link of links) {
      const resolved = resolveLink(link.targetRaw, resolverIndex);
      const targetId = resolved ? (this.getFileByPath(resolved.path)?.id ?? null) : null;
      stmt.run(
        fileId,
        link.targetRaw,
        targetId,
        link.type,
        link.heading ?? null,
        link.blockId ?? null,
        link.alias ?? null,
        link.line ?? null,
        link.context ?? null,
      );
    }
  }

  /** Build a resolver index over the current file table (+ their aliases). */
  buildResolverIndex(): ResolverIndex {
    const files = this.getAllFiles();
    const aliasRows = this.db.prepare("SELECT file_id, alias FROM aliases").all() as {
      file_id: number;
      alias: string;
    }[];
    const aliasesByFile = new Map<number, string[]>();
    for (const row of aliasRows) {
      const list = aliasesByFile.get(row.file_id) ?? [];
      list.push(row.alias);
      aliasesByFile.set(row.file_id, list);
    }
    const resolvable: ResolvableFile[] = files.map((f) => ({
      path: f.path,
      isMarkdown: f.is_markdown === 1,
      aliases: aliasesByFile.get(f.id) ?? [],
    }));
    return buildResolverIndex(resolvable);
  }

  /**
   * Recompute target_id for every link row against the current resolver
   * index. This is a SQL-only pass (no re-parsing of note content) so it is
   * cheap to run after any add/remove/rename. Returns only the rows whose
   * resolution actually changed, so the in-memory graph layer can apply a
   * precise incremental diff instead of rebuilding.
   */
  reresolveAllLinks(resolverIndex: ResolverIndex): LinkChange[] {
    const rows = this.db.prepare("SELECT id, source_id, target_raw, target_id FROM links").all() as {
      id: number;
      source_id: number;
      target_raw: string;
      target_id: number | null;
    }[];
    const changes: LinkChange[] = [];
    const update = this.db.prepare("UPDATE links SET target_id = ? WHERE id = ?");
    for (const row of rows) {
      const resolved = resolveLink(row.target_raw, resolverIndex);
      const newTargetId = resolved ? (this.getFileByPath(resolved.path)?.id ?? null) : null;
      if (newTargetId !== row.target_id) {
        update.run(newTargetId, row.id);
        changes.push({
          linkId: row.id,
          sourceId: row.source_id,
          oldTargetId: row.target_id,
          newTargetId,
        });
      }
    }
    return changes;
  }

  // --- query helpers used by MCP tools --------------------------------

  getBacklinks(targetPath: string): BacklinkRow[] {
    const target = this.getFileByPath(targetPath);
    if (!target) return [];
    return this.db
      .prepare(
        `SELECT f.path as sourcePath, f.title as sourceTitle, l.type as type, l.line as line, l.context as context
         FROM links l JOIN files f ON f.id = l.source_id
         WHERE l.target_id = ?
         ORDER BY f.path`,
      )
      .all(target.id) as BacklinkRow[];
  }

  getOutlinks(sourcePath: string): (BacklinkRow & { targetPath: string | null; targetRaw: string })[] {
    const source = this.getFileByPath(sourcePath);
    if (!source) return [];
    return this.db
      .prepare(
        `SELECT f.path as targetPath, l.target_raw as targetRaw, f.title as sourceTitle, l.type as type, l.line as line, l.context as context
         FROM links l LEFT JOIN files f ON f.id = l.target_id
         WHERE l.source_id = ?
         ORDER BY l.line`,
      )
      .all(source.id) as (BacklinkRow & { targetPath: string | null; targetRaw: string })[];
  }

  getHeadingsForFile(fileId: number): { level: number; text: string; line: number }[] {
    return this.db.prepare("SELECT level, text, line FROM headings WHERE file_id = ? ORDER BY line").all(fileId) as {
      level: number;
      text: string;
      line: number;
    }[];
  }

  getTagsForFile(fileId: number): { tag: string; source: string }[] {
    return this.db.prepare("SELECT tag, source FROM tags WHERE file_id = ?").all(fileId) as {
      tag: string;
      source: string;
    }[];
  }

  getAllTagCounts(): { tag: string; count: number }[] {
    return this.db
      .prepare("SELECT tag, COUNT(DISTINCT file_id) as count FROM tags GROUP BY tag ORDER BY count DESC")
      .all() as { tag: string; count: number }[];
  }

  getNotesByTag(tag: string, includeNested: boolean): FileRow[] {
    const pattern = includeNested ? `${tag}%` : tag;
    const op = includeNested ? "LIKE" : "=";
    return this.db
      .prepare(`SELECT DISTINCT f.* FROM files f JOIN tags t ON t.file_id = f.id WHERE t.tag ${op} ? ORDER BY f.path`)
      .all(pattern) as FileRow[];
  }

  findOrphans(): FileRow[] {
    return this.db
      .prepare(
        `SELECT f.* FROM files f
         WHERE f.is_markdown = 1
           AND NOT EXISTS (SELECT 1 FROM links l WHERE l.source_id = f.id)
           AND NOT EXISTS (SELECT 1 FROM links l WHERE l.target_id = f.id)
         ORDER BY f.path`,
      )
      .all() as FileRow[];
  }

  findUnresolved(): {
    targetRaw: string;
    sourcePath: string;
    line: number | null;
    heading: string | null;
    blockId: string | null;
  }[] {
    return this.db
      .prepare(
        `SELECT l.target_raw as targetRaw, f.path as sourcePath, l.line as line, l.heading as heading, l.block_id as blockId
         FROM links l JOIN files f ON f.id = l.source_id
         WHERE l.target_id IS NULL
         ORDER BY l.target_raw`,
      )
      .all() as {
      targetRaw: string;
      sourcePath: string;
      line: number | null;
      heading: string | null;
      blockId: string | null;
    }[];
  }

  countResolvedLinks(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM links WHERE target_id IS NOT NULL").get() as {
      c: number;
    };
    return row.c;
  }

  private searchTable(
    table: "files_fts" | "files_fts_trigram",
    query: string,
    limit: number,
    filter: SearchFilter,
  ): SearchRow[] {
    const clauses = [`${table} MATCH ?`];
    const bindings: Array<string | number> = [query];
    if (filter.isMarkdown !== undefined) {
      clauses.push("f.is_markdown = ?");
      bindings.push(filter.isMarkdown ? 1 : 0);
    }
    if (filter.folderPrefix) {
      clauses.push("instr(f.path, ?) = 1");
      bindings.push(filter.folderPrefix);
    }
    if (filter.extensionSuffix) {
      clauses.push("substr(lower(f.path), -length(?)) = ?");
      bindings.push(filter.extensionSuffix, filter.extensionSuffix.toLowerCase());
    }
    bindings.push(limit);

    return this.db
      .prepare(
        `SELECT f.path as path, f.title as title, snippet(${table}, 2, '[', ']', '...', 10) as snippet
         FROM ${table} ffts JOIN files f ON f.id = ffts.rowid
         WHERE ${clauses.join(" AND ")}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...bindings) as SearchRow[];
  }

  search(query: string, limit = 20, filter: SearchFilter = {}): SearchRow[] {
    const primary = this.searchTable("files_fts", query, limit, filter);
    if (primary.length >= limit) return primary;

    // Trigram fallback: only ever adds results the word-based query above
    // missed (never reorders or replaces them) -- see files_fts_trigram in
    // schema.ts and DECISIONS.md D9. Wrapped in try/catch because the FTS5
    // query-syntax subset that's valid against files_fts isn't guaranteed
    // to be valid against a trigram-tokenized table; if it throws, the
    // word-based results already stand on their own.
    let trigram: SearchRow[];
    try {
      trigram = this.searchTable("files_fts_trigram", query, limit, filter);
    } catch {
      return primary;
    }

    const seen = new Set(primary.map((r) => r.path));
    const merged = [...primary];
    for (const row of trigram) {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      merged.push(row);
      if (merged.length >= limit) break;
    }
    return merged;
  }

  // --- semantic embeddings (see index/embeddings.ts, DECISIONS.md D20) ---

  /** Markdown files with no embedding row for this model -- new files, or files upsertFts invalidated after a content change. */
  getFilesNeedingEmbedding(model: string, limit: number): FileRow[] {
    return this.db
      .prepare(
        `SELECT f.* FROM files f
         LEFT JOIN embeddings e ON e.file_id = f.id AND e.model = ?
         WHERE f.is_markdown = 1 AND e.file_id IS NULL
         ORDER BY f.id
         LIMIT ?`,
      )
      .all(model, limit) as FileRow[];
  }

  countFilesNeedingEmbedding(model: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM files f
         LEFT JOIN embeddings e ON e.file_id = f.id AND e.model = ?
         WHERE f.is_markdown = 1 AND e.file_id IS NULL`,
      )
      .get(model) as { c: number };
    return row.c;
  }

  upsertEmbedding(fileId: number, model: string, vector: Buffer): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (file_id, model, vector, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(file_id) DO UPDATE SET model=excluded.model, vector=excluded.vector, updated_at=excluded.updated_at`,
      )
      .run(fileId, model, vector, Date.now());
  }

  getEmbedding(fileId: number, model: string): Buffer | undefined {
    const row = this.db.prepare("SELECT vector FROM embeddings WHERE file_id = ? AND model = ?").get(fileId, model) as
      { vector: Buffer } | undefined;
    return row?.vector;
  }

  getAllEmbeddings(model: string): { fileId: number; vector: Buffer }[] {
    return this.db.prepare("SELECT file_id as fileId, vector FROM embeddings WHERE model = ?").all(model) as {
      fileId: number;
      vector: Buffer;
    }[];
  }
}
