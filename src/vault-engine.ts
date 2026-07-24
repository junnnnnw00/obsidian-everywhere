import type { FSWatcher } from "chokidar";
import { VaultGraph } from "./graph/graph.js";
import { VaultDB } from "./index/db.js";
import { applyFileDelete, applyFileUpsert, fullScan, type ScanResult } from "./index/scan.js";
import { DEFAULT_EXCLUDE_DIRS } from "./vault/paths.js";
import { waitForStableVaultListing } from "./vault/wait-for-mount.js";
import { startWatcher, type WatchEvent } from "./watcher/watcher.js";

export interface VaultEngineOptions {
  vaultDir: string;
  dbPath: string;
  excludeDirs?: string[];
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
  private watcher: FSWatcher | null = null;

  constructor(options: VaultEngineOptions) {
    this.vaultDir = options.vaultDir;
    this.excludeDirs = options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
    this.db = new VaultDB(options.dbPath);
    this.graph = new VaultGraph();
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
