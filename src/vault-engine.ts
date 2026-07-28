import type { FSWatcher } from "chokidar";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { MountGuardConfig } from "./env.js";
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
  /** Opt-in protection for removable, network, and container-mounted vaults. */
  mountGuard?: MountGuardConfig;
}

export type VaultMountState = "disabled" | "healthy" | "unavailable" | "reconciling";

export interface VaultStatus {
  mountGuardEnabled: boolean;
  mountState: VaultMountState;
  mountSentinel: string | null;
  stale: boolean;
  writesAllowed: boolean;
  indexedNotes: number;
  indexedAttachments: number;
  lastReconciledAt: string | null;
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
  private readonly mountGuard: MountGuardConfig;
  private watcher: FSWatcher | null = null;
  private mountTimer: NodeJS.Timeout | null = null;
  private mountState: VaultMountState;
  private reconciliationInFlight = false;
  private lastReconciledAt: number | null = null;

  constructor(options: VaultEngineOptions) {
    this.vaultDir = options.vaultDir;
    this.excludeDirs = options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
    this.db = new VaultDB(options.dbPath);
    this.graph = new VaultGraph();
    this.embedder = options.embedder ?? defaultEmbedder;
    this.mountGuard = options.mountGuard ?? { enabled: false, recheckIntervalMs: 5000 };
    this.mountState = this.mountGuard.enabled ? "unavailable" : "disabled";
  }

  private mountIsAvailable(): boolean {
    try {
      if (!statSync(this.vaultDir).isDirectory()) return false;
      if (this.mountGuard.sentinel) {
        return existsSync(path.join(this.vaultDir, ...this.mountGuard.sentinel.split("/")));
      }
      return readdirSync(this.vaultDir).length > 0;
    } catch {
      return false;
    }
  }

  private markMountUnavailable(): void {
    if (!this.mountGuard.enabled) return;
    if (this.mountState !== "unavailable") {
      console.error(
        `[obsidian-everywhere mount-guard] Vault mount unavailable; preserving the index and blocking writes: ${this.vaultDir}`,
      );
    }
    this.mountState = "unavailable";
  }

  private async reconcileReturnedMount(): Promise<void> {
    if (!this.mountGuard.enabled || this.reconciliationInFlight) return;
    this.reconciliationInFlight = true;
    this.mountState = "reconciling";
    try {
      await waitForStableVaultListing(this.vaultDir, { requireNonEmpty: true });
      if (!this.mountIsAvailable()) {
        throw new Error(
          this.mountGuard.sentinel
            ? `Mount sentinel is missing: ${this.mountGuard.sentinel}`
            : "Vault listing is unavailable or empty.",
        );
      }
      this.refreshNow();
      this.lastReconciledAt = Date.now();
      this.mountState = "healthy";
      console.error(`[obsidian-everywhere mount-guard] Vault mount restored; full reconciliation complete.`);
    } catch (err) {
      this.mountState = "unavailable";
      console.error("[obsidian-everywhere mount-guard] Reconciliation deferred:", err);
    } finally {
      this.reconciliationInFlight = false;
    }
  }

  /** Probe mount state immediately; exposed for health checks and deterministic tests. */
  async checkMountNow(): Promise<VaultStatus> {
    if (!this.mountGuard.enabled) return this.getStatus();
    if (!this.mountIsAvailable()) {
      this.markMountUnavailable();
      return this.getStatus();
    }
    if (this.mountState === "unavailable") await this.reconcileReturnedMount();
    return this.getStatus();
  }

  getStatus(): VaultStatus {
    const counts = this.db.getFileCounts();
    return {
      mountGuardEnabled: this.mountGuard.enabled,
      mountState: this.mountState,
      mountSentinel: this.mountGuard.sentinel ?? null,
      stale: this.mountState === "unavailable" || this.mountState === "reconciling",
      writesAllowed: !this.mountGuard.enabled || this.mountState === "healthy",
      indexedNotes: counts.markdown,
      indexedAttachments: counts.attachments,
      lastReconciledAt: this.lastReconciledAt === null ? null : new Date(this.lastReconciledAt).toISOString(),
    };
  }

  writeBlockReason(): string | null {
    if (!this.mountGuard.enabled || this.mountState === "healthy") return null;
    return `Error: vault mount is ${this.mountState}; writes are blocked until mount-guard completes reconciliation.`;
  }

  /**
   * Full initial index + graph build. Call once before serving requests.
   * Waits for the vault directory's listing to stabilize first, so a
   * still-mounting external/network drive doesn't get indexed mid-attach
   * (see `waitForStableVaultListing`).
   */
  async init(): Promise<void> {
    await waitForStableVaultListing(this.vaultDir, {
      requireNonEmpty: this.mountGuard.enabled,
    });
    if (this.mountGuard.enabled && !this.mountIsAvailable()) {
      throw new Error(
        this.mountGuard.sentinel
          ? `Vault mount sentinel is missing: ${this.mountGuard.sentinel}`
          : `Vault directory is unavailable or empty: ${this.vaultDir}`,
      );
    }
    if (this.mountGuard.enabled) this.mountState = "reconciling";
    this.scanWithMountPostcondition();
    this.graph.loadFull(this.db);
    this.lastReconciledAt = Date.now();
    if (this.mountGuard.enabled) this.mountState = "healthy";
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
    const result = this.scanWithMountPostcondition();
    this.graph.loadFull(this.db);
    return result;
  }

  /**
   * Keep a guarded scan inside an outer transaction until the mount identity
   * has been checked again. If a drive/share disappears during the scan, the
   * nested fullScan changes roll back instead of committing a partial index.
   */
  private scanWithMountPostcondition(): ScanResult {
    return this.db.transaction(() => {
      const result = fullScan(this.db, this.vaultDir, this.excludeDirs);
      if (this.mountGuard.enabled && !this.mountIsAvailable()) {
        this.markMountUnavailable();
        throw new Error("Vault mount became unavailable during full reconciliation; index changes were rolled back.");
      }
      return result;
    });
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
      shouldHandleUnlink: this.mountGuard.enabled
        ? () => {
            if (this.mountIsAvailable()) return true;
            this.markMountUnavailable();
            return false;
          }
        : undefined,
      onEvent,
    });
    if (this.mountGuard.enabled && !this.mountTimer) {
      this.mountTimer = setInterval(() => void this.checkMountNow(), this.mountGuard.recheckIntervalMs);
      this.mountTimer.unref();
    }
  }

  async stopWatching(): Promise<void> {
    if (this.mountTimer) {
      clearInterval(this.mountTimer);
      this.mountTimer = null;
    }
    if (!this.watcher) return;
    await this.watcher.close();
    this.watcher = null;
  }

  async close(): Promise<void> {
    await this.stopWatching();
    this.db.close();
  }
}
