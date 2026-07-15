import { cpSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultDB } from "../index/db.js";
import { fullScan } from "../index/scan.js";
import { VaultGraph } from "../graph/graph.js";
import { startWatcher } from "./watcher.js";
import type { FSWatcher } from "chokidar";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureVault = path.resolve(here, "..", "..", "fixtures", "test-vault");

describe("startWatcher (real fs events)", () => {
  let tmpVault: string;
  let db: VaultDB;
  let graph: VaultGraph;
  let watcher: FSWatcher;

  beforeEach(async () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-watcher-"));
    cpSync(fixtureVault, tmpVault, { recursive: true });

    db = new VaultDB(":memory:");
    fullScan(db, tmpVault);
    graph = new VaultGraph();
    graph.loadFull(db);

    await new Promise<void>((resolve) => {
      watcher = startWatcher({ vaultDir: tmpVault, db, graph, onReady: () => resolve() });
    });
  });

  afterEach(async () => {
    await watcher.close();
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it("reflects a new file in both the index and the graph", async () => {
    writeFileSync(path.join(tmpVault, "New Note.md"), "Links to [[Note A]].");

    await vi.waitFor(() => {
      expect(db.getFileByPath("New Note.md")).toBeDefined();
    }, { timeout: 10000, interval: 50 });

    const outlinks = db.getOutlinks("New Note.md");
    expect(outlinks[0]?.targetPath).toBe("Note A.md");

    await vi.waitFor(() => {
      const noteA = db.getFileByPath("Note A.md")!;
      const { nodes } = graph.neighborhood(noteA.id, 1);
      expect(nodes.some((n) => n.path === "New Note.md")).toBe(true);
    }, { timeout: 10000, interval: 50 });

    expect(graph.consistencyCheck(db).ok).toBe(true);
  });

  it("reflects an edited link target in both the index and the graph", async () => {
    writeFileSync(path.join(tmpVault, "Note D.md"), "Now links to [[Note B]] instead.");

    await vi.waitFor(() => {
      const outlinks = db.getOutlinks("Note D.md");
      expect(outlinks[0]?.targetPath).toBe("Note B.md");
    }, { timeout: 10000, interval: 50 });

    expect(graph.consistencyCheck(db).ok).toBe(true);
  });

  it("removes a deleted file from both the index and the graph", async () => {
    const orphan = db.getFileByPath("Orphan Note.md")!;
    unlinkSync(path.join(tmpVault, "Orphan Note.md"));

    await vi.waitFor(() => {
      expect(db.getFileByPath("Orphan Note.md")).toBeUndefined();
    }, { timeout: 10000, interval: 50 });

    expect(graph.directed.hasNode(String(orphan.id))).toBe(false);
    expect(graph.consistencyCheck(db).ok).toBe(true);
  });

  it("re-resolves other notes' links after a rename removes a duplicate-name candidate", async () => {
    // Before rename: unqualified [[Same Name]] resolves to Folder1 (shortest+alpha).
    const before = db.getOutlinks("Ambiguous Resolution Test.md");
    expect(before[0]?.targetPath).toBe("Folder1/Same Name.md");

    renameSync(
      path.join(tmpVault, "Folder1", "Same Name.md"),
      path.join(tmpVault, "Folder1", "Zzz Renamed.md"),
    );

    await vi.waitFor(() => {
      const outlinks = db.getOutlinks("Ambiguous Resolution Test.md");
      expect(outlinks[0]?.targetPath).toBe("Folder2/Same Name.md");
    }, { timeout: 10000, interval: 50 });

    expect(db.getFileByPath("Folder1/Same Name.md")).toBeUndefined();
    expect(db.getFileByPath("Folder1/Zzz Renamed.md")).toBeDefined();
    expect(graph.consistencyCheck(db).ok).toBe(true);
  });
});
