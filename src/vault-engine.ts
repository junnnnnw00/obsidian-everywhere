import type { FSWatcher } from "chokidar";
import { VaultGraph } from "./graph/graph.js";
import { VaultDB } from "./index/db.js";
import {
  defaultEmbedder,
  noteEmbeddingText,
  vectorToBuffer,
  EMBEDDING_MODEL,
  type Embedder,
} from "./index/embeddings.js";
import { applyFileDelete, applyFileUpsert, fullScan, type ScanResult } from "./index/scan.js";
import { DEFAULT_EXCLUDE_DIRS } from "./vault/paths.js";
import { waitForStableVaultListing } from "./vault/wait-for-mount.js";
import { startWatcher, type WatchEvent } from "./watcher/watcher.js";

export interface VaultEngineOptions {
  vaultDir: string;
  dbPath: string;
  excludeDirs?: string[];
  /** Injectable for tests; defaults to the real transformers.js-backed embedder (lazily loaded on first use). */
  embedder?: Embedder;
}

/**
 * Ties the SQLite index, the in-memory graph, and the filesystem watcher
 * together behind one API. This is what the MCP tool layer talks to.
 */
export class VaultEngine {
  readonly db: VaultDB;
  readonly graph: VaultGraph;
  readonly vaultDir: string;
  private readonly excludeDirs: string[];
  private readonly embedder: Embedder;
  private watcher: FSWatcher | null = null;

  constructor(options: VaultEngineOptions) {
    this.vaultDir = options.vaultDir;
    this.excludeDirs = options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
    this.db = new VaultDB(options.dbPath);
    this.graph = new VaultGraph();
    this.embedder = options.embedder ?? defaultEmbedder;
  }

  /**
   * Full initial index + graph build. Call once before serving requests.
   * Waits for the vault directory's listing to stabilize first, so a
   * still-mounting external/network drive doesn't get indexed mid-attach
   * (see `waitForStableVaultListing`).
   */
  async init(): Promise<void> {
    await waitForStableVaultListing(this.vaultDir);
    fullScan(this.db, this.vaultDir, this.excludeDirs);
    this.graph.loadFull(this.db);
  }

  /**
   * Synchronously reindex one file right after a write tool changes it on
   * disk, instead of waiting for the (debounced) filesystem watcher event.
   * Idempotent with the watcher: `applyFileUpsert` is mtime+hash-gated, so
   * the watcher's own later event for the same write is a no-op.
   */
  indexFileNow(relPath: string): ScanResult {
    const result = applyFileUpsert(this.db, this.vaultDir, relPath);
    this.graph.applyScanResult(this.db, result);
    return result;
  }

  /** Remove one file from the index immediately after a write tool deletes it. */
  deleteFileNow(relPath: string): ScanResult {
    const result = applyFileDelete(this.db, relPath);
    this.graph.applyScanResult(this.db, result);
    return result;
  }

  /** Reconcile a multi-file filesystem transaction and rebuild the in-memory graph. */
  refreshNow(): ScanResult {
    const result = fullScan(this.db, this.vaultDir, this.excludeDirs);
    this.graph.loadFull(this.db);
    return result;
  }

  /**
   * Computes and stores embeddings for up to `limit` markdown files that
   * don't have a current one (new files, or files changed since their last
   * embedding -- see VaultDB.upsertFts). Deliberately not run during
   * init()/fullScan()/the watcher: embedding is comparatively expensive and
   * most vaults never touch a semantic tool in a given session, so the cost
   * is paid lazily by the tools that actually need it (semantic_search,
   * get_related's semantic method), bounded per call so one request can't
   * block indefinitely on a large backlog. See DECISIONS.md D20.
   */
  async ensureEmbeddingsFresh(limit: number): Promise<{ embedded: number; remaining: number }> {
    const pending = this.db.getFilesNeedingEmbedding(EMBEDDING_MODEL, limit);
    if (pending.length === 0) return { embedded: 0, remaining: 0 };
    const vectors = await this.embedder(
      pending.map((f) => noteEmbeddingText(f)),
      "passage",
    );
    for (let i = 0; i < pending.length; i++) {
      this.db.upsertEmbedding(pending[i]!.id, EMBEDDING_MODEL, vectorToBuffer(vectors[i]!));
    }
    return { embedded: pending.length, remaining: this.db.countFilesNeedingEmbedding(EMBEDDING_MODEL) };
  }

  /** Embeds a free-text search query with the "query" prefix e5 models expect (asymmetric vs. the "passage" prefix notes are embedded with). */
  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embedder([text], "query");
    return vector!;
  }

  watch(onEvent?: (event: WatchEvent) => void): void {
    if (this.watcher) return;
    this.watcher = startWatcher({
      vaultDir: this.vaultDir,
      db: this.db,
      graph: this.graph,
      excludeDirs: this.excludeDirs,
      onEvent,
    });
  }

  async stopWatching(): Promise<void> {
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }

  async close(): Promise<void> {
    await this.stopWatching();
    this.db.close();
  }
}
