import type { FSWatcher } from "chokidar";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ATTACHMENT_EXTRACTOR_VERSION, extractAttachment, type AttachmentExtraction } from "./attachments/extract.js";
import type { MountGuardConfig } from "./env.js";
import { VaultGraph } from "./graph/graph.js";
import { VaultDB, type FileRow } from "./index/db.js";
import {
  defaultEmbedder,
  noteEmbeddingText,
  vectorToBuffer,
  EMBEDDING_MODEL,
  type Embedder,
} from "./index/embeddings.js";
import { applyFileDelete, applyFileUpsert, fullScan, type ScanResult } from "./index/scan.js";
import { DEFAULT_EXCLUDE_DIRS, resolveExistingVaultPath, shouldExclude, toPosixPath } from "./vault/paths.js";
import { waitForStableVaultListing } from "./vault/wait-for-mount.js";
import { startWatcher, type WatchEvent } from "./watcher/watcher.js";

export interface VaultEngineOptions {
  vaultDir: string;
  dbPath: string;
  excludeDirs?: string[];
  /** Injectable for tests; defaults to the real transformers.js-backed embedder (lazily loaded on first use). */
  embedder?: Embedder;
  /** Explicit opt-in because the bundled multilingual model exceeds the low-memory runtime target. */
  semanticSearchEnabled?: boolean;
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
  readonly semanticSearchEnabled: boolean;
  private readonly mountGuard: MountGuardConfig;
  private watcher: FSWatcher | null = null;
  private watchingRequested = false;
  private watcherOnEvent: ((event: WatchEvent) => void) | undefined;
  private cancelWatcherReadyWait: (() => void) | null = null;
  private mountTimer: NodeJS.Timeout | null = null;
  private mountState: VaultMountState;
  private reconciliationPromise: Promise<void> | null = null;
  private lastReconciledAt: number | null = null;

  constructor(options: VaultEngineOptions) {
    this.vaultDir = options.vaultDir;
    this.excludeDirs = options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
    this.db = new VaultDB(options.dbPath);
    this.graph = new VaultGraph();
    this.embedder = options.embedder ?? defaultEmbedder;
    this.semanticSearchEnabled = options.semanticSearchEnabled ?? options.embedder !== undefined;
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

  private async performReturnedMountReconciliation(): Promise<void> {
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
      // Filesystem watchers can remain attached to the old filesystem
      // instance after a removable drive or network share is mounted again.
      // Recreate an active watcher and wait for its initial directory walk
      // before reconciling, so changes made after recovery are not silently
      // missed by an apparently healthy long-running server.
      await this.restartWatcherAfterMount();
      this.refreshNow();
      this.lastReconciledAt = Date.now();
      this.mountState = "healthy";
      console.error(`[obsidian-everywhere mount-guard] Vault mount restored; full reconciliation complete.`);
    } catch (err) {
      this.mountState = "unavailable";
      console.error("[obsidian-everywhere mount-guard] Reconciliation deferred:", err);
    }
  }

  private async reconcileReturnedMount(): Promise<void> {
    if (!this.mountGuard.enabled) return;
    if (this.reconciliationPromise) return this.reconciliationPromise;

    const reconciliation = this.performReturnedMountReconciliation();
    this.reconciliationPromise = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.reconciliationPromise === reconciliation) this.reconciliationPromise = null;
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

  /**
   * Recover one exact vault-relative file that exists on disk but has not yet
   * reached the index (for example during a short watcher lag). This never
   * walks the vault, follows symlinks, or accepts an excluded/traversal path.
   */
  indexExistingFileIfPresent(requestedPath: string): FileRow | undefined {
    if (this.getStatus().stale) return undefined;
    if (this.mountGuard.enabled && !this.mountIsAvailable()) {
      this.markMountUnavailable();
      return undefined;
    }

    const rel = requestedPath.trim().split("\\").join("/").normalize("NFC");
    if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return undefined;
    const segments = rel.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
    if (shouldExclude(rel, this.excludeDirs)) return undefined;

    try {
      const absPath = resolveExistingVaultPath(this.vaultDir, rel);
      const absVault = path.resolve(this.vaultDir);
      const lexicalRel = path.relative(absVault, path.resolve(absPath));
      if (!lexicalRel || lexicalRel.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRel)) return undefined;

      // walkVaultFiles ignores symlink entries. Match that behavior here for
      // every component, not only the final file: otherwise `vault/link/file`
      // could follow an in-vault directory symlink to a file outside the
      // operator-approved vault.
      let cursor = absVault;
      let finalIsFile = false;
      for (const segment of lexicalRel.split(path.sep)) {
        cursor = path.join(cursor, segment);
        const entry = lstatSync(cursor);
        if (entry.isSymbolicLink()) return undefined;
        finalIsFile = entry.isFile();
      }
      if (!finalIsFile) return undefined;

      const realVault = realpathSync.native(absVault);
      const realFile = realpathSync.native(absPath);
      const realRel = path.relative(realVault, realFile);
      if (!realRel || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) return undefined;
      // realpath also recovers the actual on-disk casing on case-insensitive
      // filesystems, preventing duplicate DB identities for Final/FINAL.
      const diskRel = toPosixPath(realRel);
      if (shouldExclude(diskRel, this.excludeDirs)) return undefined;

      // Keep the targeted upsert under the same before/after mount invariant
      // as a full reconciliation. Apply the graph change only after the outer
      // DB transaction commits, so a disappearing mount cannot leave the
      // persistent index rolled back but the in-memory graph advanced.
      const indexed = this.db.transaction(() => {
        const scanResult = applyFileUpsert(this.db, this.vaultDir, diskRel);
        if (this.mountGuard.enabled && !this.mountIsAvailable()) {
          this.markMountUnavailable();
          throw new Error("Vault mount became unavailable during exact-file indexing.");
        }
        return { scanResult, file: this.db.getFileByPath(diskRel.normalize("NFC")) };
      });
      this.graph.applyScanResult(this.db, indexed.scanResult);
      return indexed.file;
    } catch {
      if (this.mountGuard.enabled && !this.mountIsAvailable()) this.markMountUnavailable();
      return undefined;
    }
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
    if (!this.semanticSearchEnabled) {
      throw new Error(
        "Semantic search is disabled in low-memory mode. Set OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC=true to opt in.",
      );
    }
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
    if (!this.semanticSearchEnabled) {
      throw new Error(
        "Semantic search is disabled in low-memory mode. Set OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC=true to opt in.",
      );
    }
    const [vector] = await this.embedder([text], "query");
    return vector!;
  }

  private async extractIndexedAttachment(fileId: number): Promise<AttachmentExtraction | null> {
    const file = this.db.getFileById(fileId);
    if (!file || file.is_markdown === 1) return null;
    const absPath = resolveExistingVaultPath(this.vaultDir, file.path);
    let size: number;
    try {
      size = statSync(absPath).size;
    } catch (error) {
      const extraction: AttachmentExtraction = {
        status: "error",
        mimeType: "application/octet-stream",
        text: null,
        metadata: {},
        error: error instanceof Error ? error.message : String(error),
      };
      this.db.upsertAttachmentExtraction(file, ATTACHMENT_EXTRACTOR_VERSION, extraction);
      return extraction;
    }
    const extraction = await extractAttachment(absPath, size);
    this.db.upsertAttachmentExtraction(file, ATTACHMENT_EXTRACTOR_VERSION, extraction);
    return extraction;
  }

  /** Ensure one requested attachment has a current persistent extraction. */
  async ensureAttachmentExtracted(fileId: number): Promise<AttachmentExtraction | null> {
    const file = this.db.getFileById(fileId);
    if (!file || file.is_markdown === 1) return null;
    const cached = this.db.getAttachmentExtraction(file.id);
    if (cached && cached.source_hash === file.hash && cached.extractor_version === ATTACHMENT_EXTRACTOR_VERSION) {
      return {
        status: cached.status,
        mimeType: cached.mime_type,
        text: cached.text_content,
        metadata: JSON.parse(cached.metadata_json) as Record<string, unknown>,
        error: cached.error,
      };
    }
    return this.extractIndexedAttachment(file.id);
  }

  /**
   * Lazily extract a bounded batch of new/changed attachments. Search tools
   * call this before querying FTS; direct read_file always extracts its exact
   * target immediately.
   */
  async ensureAttachmentExtractionsFresh(limit: number): Promise<{ extracted: number; remaining: number }> {
    const pending = this.db.getFilesNeedingAttachmentExtraction(ATTACHMENT_EXTRACTOR_VERSION, limit);
    for (const file of pending) await this.extractIndexedAttachment(file.id);
    return {
      extracted: pending.length,
      remaining: this.db.countFilesNeedingAttachmentExtraction(ATTACHMENT_EXTRACTOR_VERSION),
    };
  }

  private createWatcher(): FSWatcher {
    return startWatcher({
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
      onEvent: this.watcherOnEvent,
    });
  }

  private async restartWatcherAfterMount(): Promise<void> {
    if (!this.watchingRequested) return;
    if (this.watcher) {
      const previous = this.watcher;
      this.watcher = null;
      await previous.close();
    }
    if (!this.watchingRequested) return;

    const replacement = this.createWatcher();
    this.watcher = replacement;
    try {
      const readyState = await new Promise<"ready" | "cancelled">((resolve, reject) => {
        const cleanup = (): void => {
          replacement.off("ready", onReady);
          replacement.off("error", onError);
          if (this.cancelWatcherReadyWait === onCancel) this.cancelWatcherReadyWait = null;
        };
        const onReady = (): void => {
          cleanup();
          resolve("ready");
        };
        const onError = (error: unknown): void => {
          cleanup();
          reject(error);
        };
        const onCancel = (): void => {
          cleanup();
          resolve("cancelled");
        };
        this.cancelWatcherReadyWait = onCancel;
        replacement.once("ready", onReady);
        replacement.once("error", onError);
      });
      if (readyState === "cancelled" || !this.watchingRequested) {
        await replacement.close();
        if (this.watcher === replacement) this.watcher = null;
      }
    } catch (error) {
      await replacement.close();
      if (this.watcher === replacement) this.watcher = null;
      throw error;
    }
  }

  watch(onEvent?: (event: WatchEvent) => void): void {
    if (this.watcher) return;
    this.watchingRequested = true;
    this.watcherOnEvent = onEvent;
    this.watcher = this.createWatcher();
    if (this.mountGuard.enabled && !this.mountTimer) {
      this.mountTimer = setInterval(() => void this.checkMountNow(), this.mountGuard.recheckIntervalMs);
      this.mountTimer.unref();
    }
  }

  async stopWatching(): Promise<void> {
    this.watchingRequested = false;
    this.cancelWatcherReadyWait?.();
    if (this.mountTimer) {
      clearInterval(this.mountTimer);
      this.mountTimer = null;
    }
    if (this.reconciliationPromise) await this.reconciliationPromise;
    const watcher = this.watcher;
    this.watcher = null;
    this.watcherOnEvent = undefined;
    if (watcher) await watcher.close();
  }

  async close(): Promise<void> {
    await this.stopWatching();
    this.db.close();
  }
}
