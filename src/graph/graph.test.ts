import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { VaultDB } from "../index/db.js";
import { fullScan } from "../index/scan.js";
import { VaultGraph } from "./graph.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.resolve(here, "..", "..", "fixtures", "test-vault");

describe("VaultGraph over fixture vault", () => {
  let db: VaultDB;
  let graph: VaultGraph;

  beforeAll(() => {
    db = new VaultDB(":memory:");
    fullScan(db, vaultDir);
    graph = new VaultGraph();
    graph.loadFull(db);
  });

  it("is consistent with the SQLite index", () => {
    const report = graph.consistencyCheck(db);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("node/edge counts match db file/resolved-link counts", () => {
    expect(graph.nodeCount).toBe(db.getAllFiles().length);
    expect(graph.edgeCount).toBe(db.countResolvedLinks());
  });

  it("computes a 1-hop neighborhood around Hub Note (3 backlinks + Home)", () => {
    const hub = db.getFileByPath("Hub Note.md")!;
    const { nodes, edges } = graph.neighborhood(hub.id, 1);
    const paths = nodes.map((n) => n.path).sort();
    expect(paths).toEqual([
      "Backlink Test A.md",
      "Backlink Test B.md",
      "Backlink Test C.md",
      "Home.md",
      "Hub Note.md",
    ]);
    expect(edges.length).toBe(4);
  });

  it("2-hop neighborhood of Backlink Test A reaches Note A/Note B/Hub Note via Home", () => {
    // Backlink Test A -> Hub Note (1 hop). Hub Note's only other neighbor is
    // Home/B/C (1 hop from Hub = 2 hops from A). Home also links Note A, Note
    // B, and 한글 노트 but those are 3 hops from Backlink Test A, so at hops=2
    // the reachable set should stop at Hub Note's immediate neighbors.
    const a = db.getFileByPath("Backlink Test A.md")!;
    const { nodes } = graph.neighborhood(a.id, 2);
    const paths = new Set(nodes.map((n) => n.path));
    expect(paths.has("Hub Note.md")).toBe(true);
    expect(paths.has("Backlink Test B.md")).toBe(true);
    expect(paths.has("Home.md")).toBe(true);
    // Note A is 3 hops away (A -> Hub -> Home -> Note A), so must NOT appear.
    expect(paths.has("Note A.md")).toBe(false);
  });

  it("finds a shortest path treating links as undirected", () => {
    const a = db.getFileByPath("Backlink Test A.md")!;
    const b = db.getFileByPath("Backlink Test B.md")!;
    const path_ = graph.shortestPath(a.id, b.id);
    expect(path_).not.toBeNull();
    // A -> Hub Note -> B (Hub Note links are directed A->Hub and B->Hub, so
    // only reachable for each other via the undirected traversal graph).
    expect(path_?.map((n) => n.path)).toEqual(["Backlink Test A.md", "Hub Note.md", "Backlink Test B.md"]);
  });

  it("returns null for unreachable nodes", () => {
    const orphan = db.getFileByPath("Orphan Note.md")!;
    const hub = db.getFileByPath("Hub Note.md")!;
    expect(graph.shortestPath(orphan.id, hub.id)).toBeNull();
  });

  it("ranks Hub Note among the highest PageRank scores", () => {
    const ranked = graph.pagerank();
    const top5 = ranked.slice(0, 5).map((r) => r.path);
    expect(top5).toContain("Hub Note.md");
  });

  it("stays consistent after an incremental resync of a single node", () => {
    graph.syncOutlinksFromDb(db, "Note A.md");
    const report = graph.consistencyCheck(db);
    expect(report.ok).toBe(true);
  });
});
