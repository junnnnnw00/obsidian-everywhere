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

export class VaultDB {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
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

  upsertFileMeta(meta: FileMetaInput): number {
    const now = Date.now();
    const existing = this.getFileByPath(meta.path);
    if (existing) {
      this.db
        .prepare(
          `UPDATE files SET title=?, is_markdown=?, mtime=?, hash=?, frontmatter_json=?, raw_content=?, updated_at=? WHERE id=?`,
        )
        .run(meta.title, meta.isMarkdown ? 1 : 0, meta.mtime, meta.hash, meta.frontmatterJson, meta.rawContent, now, existing.id);
      this.upsertFts(existing.id, meta.path, meta.title, meta.rawContent);
      return existing.id;
    }
    const info = this.db
      .prepare(
        `INSERT INTO files (path, title, is_markdown, mtime, hash, frontmatter_json, raw_content, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(meta.path, meta.title, meta.isMarkdown ? 1 : 0, meta.mtime, meta.hash, meta.frontmatterJson, meta.rawContent, now);
    const id = Number(info.lastInsertRowid);
    this.upsertFts(id, meta.path, meta.title, meta.rawContent);
    return id;
  }

  deleteFileByPath(path: string): number | null {
    const existing = this.getFileByPath(path);
    if (!existing) return null;
    this.db.prepare("DELETE FROM files_fts WHERE rowid = ?").run(existing.id);
    this.db.prepare("DELETE FROM files WHERE id = ?").run(existing.id);
    return existing.id;
  }

  private upsertFts(id: number, path: string, title: string | null, content: string | null): void {
    this.db.prepare("DELETE FROM files_fts WHERE rowid = ?").run(id);
    this.db
      .prepare("INSERT INTO files_fts (rowid, path, title, content) VALUES (?,?,?,?)")
      .run(id, path, title ?? "", content ?? "");
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
      const targetId = resolved ? this.getFileByPath(resolved.path)?.id ?? null : null;
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
    const rows = this.db
      .prepare("SELECT id, source_id, target_raw, target_id FROM links")
      .all() as { id: number; source_id: number; target_raw: string; target_id: number | null }[];
    const changes: LinkChange[] = [];
    const update = this.db.prepare("UPDATE links SET target_id = ? WHERE id = ?");
    for (const row of rows) {
      const resolved = resolveLink(row.target_raw, resolverIndex);
      const newTargetId = resolved ? this.getFileByPath(resolved.path)?.id ?? null : null;
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
      .prepare(
        `SELECT DISTINCT f.* FROM files f JOIN tags t ON t.file_id = f.id WHERE t.tag ${op} ? ORDER BY f.path`,
      )
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

  findUnresolved(): { targetRaw: string; sourcePath: string; line: number | null }[] {
    return this.db
      .prepare(
        `SELECT l.target_raw as targetRaw, f.path as sourcePath, l.line as line
         FROM links l JOIN files f ON f.id = l.source_id
         WHERE l.target_id IS NULL
         ORDER BY l.target_raw`,
      )
      .all() as { targetRaw: string; sourcePath: string; line: number | null }[];
  }

  countResolvedLinks(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM links WHERE target_id IS NOT NULL").get() as {
      c: number;
    };
    return row.c;
  }

  search(query: string, limit = 20): { path: string; title: string | null; snippet: string }[] {
    return this.db
      .prepare(
        `SELECT f.path as path, f.title as title, snippet(files_fts, 2, '[', ']', '...', 10) as snippet
         FROM files_fts ffts JOIN files f ON f.id = ffts.rowid
         WHERE files_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as { path: string; title: string | null; snippet: string }[];
  }
}
