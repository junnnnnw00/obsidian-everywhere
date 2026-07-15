import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import type { VaultDB } from "../index/db.js";
import { applyFileDelete, applyFileUpsert, type ScanResult } from "../index/scan.js";
import type { VaultGraph } from "../graph/graph.js";
import { DEFAULT_EXCLUDE_DIRS, shouldExclude, toPosixPath } from "../vault/paths.js";

export type WatchEventType = "add" | "change" | "unlink";

export interface WatchEvent {
  type: WatchEventType;
  path: string;
  scanResult: ScanResult;
}

export interface StartWatcherOptions {
  vaultDir: string;
  db: VaultDB;
  graph: VaultGraph;
  excludeDirs?: string[];
  onEvent?: (event: WatchEvent) => void;
  onReady?: () => void;
}

/**
 * Wires filesystem events to incremental index + graph updates. Renames are
 * not a distinct chokidar event (chokidar, like the underlying OS watch
 * APIs, reports them as an unlink + add pair) — each half already triggers
 * `reresolveAllLinks`, so cross-file link re-resolution on rename falls out
 * of the normal add/delete handling without special-casing.
 */
export function startWatcher(options: StartWatcherOptions): FSWatcher {
  const excludeDirs = options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;

  const watcher = chokidar.watch(options.vaultDir, {
    ignoreInitial: true,
    ignored: (filePath: string) => {
      const rel = toPosixPath(path.relative(options.vaultDir, filePath));
      return rel !== "" && shouldExclude(rel, excludeDirs);
    },
  });

  const handle = (type: WatchEventType, absPath: string): void => {
    const rel = toPosixPath(path.relative(options.vaultDir, absPath));
    const scanResult =
      type === "unlink" ? applyFileDelete(options.db, rel) : applyFileUpsert(options.db, options.vaultDir, rel);
    options.graph.applyScanResult(options.db, scanResult);
    options.onEvent?.({ type, path: rel, scanResult });
  };

  watcher.on("add", (p) => handle("add", p));
  watcher.on("change", (p) => handle("change", p));
  watcher.on("unlink", (p) => handle("unlink", p));
  if (options.onReady) watcher.on("ready", options.onReady);

  return watcher;
}
