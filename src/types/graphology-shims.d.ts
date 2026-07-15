// The published type declarations for these packages don't resolve cleanly
// under TypeScript's NodeNext module resolution (their package.json export
// maps predate the "types" condition convention). These ambient shims
// describe the same runtime shape so our code can typecheck; they have no
// effect on the actual JS that runs at runtime.

declare module "graphology" {
  import type { AbstractGraph, Attributes } from "graphology-types";

  export default class Graph<
    NodeAttributes extends Attributes = Attributes,
    EdgeAttributes extends Attributes = Attributes,
    GraphAttributes extends Attributes = Attributes,
  > extends AbstractGraph<NodeAttributes, EdgeAttributes, GraphAttributes> {}
}

declare module "graphology-metrics/centrality/pagerank.js" {
  import type Graph from "graphology";

  type PagerankMapping = { [node: string]: number };

  export default function pagerank(
    graph: Graph<any, any>,
    options?: {
      getEdgeWeight?: string | null;
      alpha?: number;
      maxIterations?: number;
      tolerance?: number;
    },
  ): PagerankMapping;
}
