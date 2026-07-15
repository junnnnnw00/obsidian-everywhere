import Graph from "graphology";
import { bidirectional } from "graphology-shortest-path/unweighted.js";
import pagerank from "graphology-metrics/centrality/pagerank.js";
import type { FileRow, VaultDB } from "../index/db.js";

export interface GraphNodeAttrs {
  path: string;
  title: string | null;
  isMarkdown: boolean;
}

export interface GraphNodeInfo extends GraphNodeAttrs {
  id: number;
}

export interface GraphEdgeInfo {
  source: number;
  target: number;
  type: string;
}

export interface ConsistencyReport {
  ok: boolean;
  issues: string[];
}

/**
 * In-memory traversal layer over the SQLite index. Two graphology
 * instances share edge keys: `directed` preserves link direction (used for
 * backlinks/outlinks/PageRank), `undirected` is used purely for hop-based
 * neighborhood and shortest-path queries where link direction should not
 * matter. Both are updated incrementally per touched node — never rebuilt
 * from scratch except at `loadFull` (startup).
 */
export class VaultGraph {
  readonly directed: Graph<GraphNodeAttrs, { type: string }>;
  readonly undirected: Graph<GraphNodeAttrs, { type: string }>;
  private pathToId = new Map<string, string>();
  private outEdgeKeysByNode = new Map<string, Set<string>>();

  constructor() {
    this.directed = new Graph({ type: "directed", multi: true });
    this.undirected = new Graph({ type: "undirected", multi: true });
  }

  get nodeCount(): number {
    return this.directed.order;
  }

  get edgeCount(): number {
    return this.directed.size;
  }

  private nodeAttrsFromRow(f: FileRow): GraphNodeAttrs {
    return { path: f.path, title: f.title, isMarkdown: f.is_markdown === 1 };
  }

  private addOrUpdateNode(f: FileRow): void {
    const key = String(f.id);
    const attrs = this.nodeAttrsFromRow(f);
    if (this.directed.hasNode(key)) {
      this.directed.mergeNodeAttributes(key, attrs);
      this.undirected.mergeNodeAttributes(key, attrs);
    } else {
      this.directed.addNode(key, attrs);
      this.undirected.addNode(key, attrs);
    }
    this.pathToId.set(f.path, key);
  }

  /** Build the graph from scratch. Only called at startup. */
  loadFull(db: VaultDB): void {
    this.directed.clear();
    this.undirected.clear();
    this.pathToId.clear();
    this.outEdgeKeysByNode.clear();

    const files = db.getAllFiles();
    for (const f of files) this.addOrUpdateNode(f);
    for (const f of files) this.syncOutlinksFromDb(db, f.path);
  }

  upsertNodeFromDb(db: VaultDB, path: string): void {
    const f = db.getFileByPath(path);
    if (f) this.addOrUpdateNode(f);
  }

  removeNodeByPath(path: string): void {
    const key = this.pathToId.get(path);
    if (key === undefined) return;
    if (this.directed.hasNode(key)) this.directed.dropNode(key);
    if (this.undirected.hasNode(key)) this.undirected.dropNode(key);
    this.pathToId.delete(path);
    this.outEdgeKeysByNode.delete(key);
  }

  /**
   * Resync exactly this node's outgoing edges against the DB. Drops the
   * edge set previously added for this node (tracked locally, since DB
   * link row ids are not stable across re-parses) and re-adds the current
   * resolved outlinks. Does not touch any other node's edges.
   */
  syncOutlinksFromDb(db: VaultDB, path: string): void {
    const source = db.getFileByPath(path);
    if (!source) return;
    const key = String(source.id);
    if (!this.directed.hasNode(key)) this.addOrUpdateNode(source);

    const previousKeys = this.outEdgeKeysByNode.get(key);
    if (previousKeys) {
      for (const edgeKey of previousKeys) {
        if (this.directed.hasEdge(edgeKey)) this.directed.dropEdge(edgeKey);
        if (this.undirected.hasEdge(edgeKey)) this.undirected.dropEdge(edgeKey);
      }
    }

    const outlinks = db.getOutlinks(path).filter((l) => l.targetPath !== null);
    const newKeys = new Set<string>();
    outlinks.forEach((link, i) => {
      const targetKey = this.pathToId.get(link.targetPath as string);
      if (targetKey === undefined) return;
      const edgeKey = `${key}->${targetKey}#${i}`;
      newKeys.add(edgeKey);
      this.directed.addEdgeWithKey(edgeKey, key, targetKey, { type: link.type });
      this.undirected.addEdgeWithKey(edgeKey, key, targetKey, { type: link.type });
    });
    this.outEdgeKeysByNode.set(key, newKeys);
  }

  /** Apply a scan result: resync touched nodes' edges, drop removed nodes. */
  applyScanResult(
    db: VaultDB,
    scanResult: {
      addedFiles: string[];
      updatedFiles: string[];
      removedFiles: string[];
      linkChanges: { sourceId: number }[];
    },
  ): void {
    for (const path of scanResult.removedFiles) this.removeNodeByPath(path);

    const touchedPaths = new Set<string>([...scanResult.addedFiles, ...scanResult.updatedFiles]);
    for (const change of scanResult.linkChanges) {
      const row = db.getFileById(change.sourceId);
      if (row) touchedPaths.add(row.path);
    }
    for (const path of touchedPaths) {
      this.upsertNodeFromDb(db, path);
      this.syncOutlinksFromDb(db, path);
    }
  }

  private toNodeInfo(key: string): GraphNodeInfo {
    const attrs = this.directed.getNodeAttributes(key);
    return { id: Number(key), ...attrs };
  }

  neighborhood(fileId: number, hops = 2): { nodes: GraphNodeInfo[]; edges: GraphEdgeInfo[] } {
    const start = String(fileId);
    if (!this.undirected.hasNode(start)) return { nodes: [], edges: [] };

    const visited = new Set<string>([start]);
    let frontier = [start];
    for (let h = 0; h < hops && frontier.length > 0; h++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const neighbor of this.undirected.neighbors(node)) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }

    const nodes = [...visited].map((k) => this.toNodeInfo(k));
    const edges: GraphEdgeInfo[] = [];
    this.directed.forEachEdge((_edgeKey, attrs, source, target) => {
      if (visited.has(source) && visited.has(target)) {
        edges.push({ source: Number(source), target: Number(target), type: attrs.type });
      }
    });

    return { nodes, edges };
  }

  shortestPath(fromId: number, toId: number): GraphNodeInfo[] | null {
    const a = String(fromId);
    const b = String(toId);
    if (!this.undirected.hasNode(a) || !this.undirected.hasNode(b)) return null;
    const path = bidirectional(this.undirected, a, b);
    if (!path) return null;
    return path.map((k) => this.toNodeInfo(k));
  }

  pagerank(): { id: number; path: string; title: string | null; score: number }[] {
    if (this.directed.order === 0) return [];
    const scores = pagerank(this.directed, { getEdgeWeight: null });
    return this.directed
      .nodes()
      .map((k) => {
        const attrs = this.directed.getNodeAttributes(k);
        return { id: Number(k), path: attrs.path, title: attrs.title, score: scores[k] ?? 0 };
      })
      .sort((x, y) => y.score - x.score);
  }

  consistencyCheck(db: VaultDB): ConsistencyReport {
    const issues: string[] = [];
    const files = db.getAllFiles();

    if (this.directed.order !== files.length) {
      issues.push(`node count mismatch: graph=${this.directed.order} db=${files.length}`);
    }
    for (const f of files) {
      if (!this.pathToId.has(f.path)) issues.push(`missing graph node for db file: ${f.path}`);
    }

    const resolvedLinkCount = db.countResolvedLinks();
    if (this.directed.size !== resolvedLinkCount) {
      issues.push(`edge count mismatch: graph=${this.directed.size} db=${resolvedLinkCount}`);
    }

    return { ok: issues.length === 0, issues };
  }
}
