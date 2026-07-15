import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "../version.js";
import type { VaultEngine } from "../vault-engine.js";
import * as tools from "./tools.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

export function createServer(engine: VaultEngine): McpServer {
  const server = new McpServer({ name: "obsidian-everywhere", version: VERSION }, { capabilities: { tools: {} } });

  server.registerTool(
    "vault_overview",
    {
      title: "Vault Overview",
      description:
        "Get a high-level picture of the vault: note counts, top tags, hub notes by PageRank, and recently modified notes. Good first call at the start of a conversation.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => textResult(tools.vaultOverview(engine)),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search Notes",
      description:
        "Full-text search over note content and titles, with optional tag/folder filters. Each result includes its outgoing/incoming link counts and tags.",
      inputSchema: {
        query: z.string().optional().describe("Full-text search query (FTS5 syntax). Omit to just filter by tag/folder."),
        tag: z.string().optional().describe("Filter to notes carrying this tag (nested tags match as a prefix)."),
        folder: z.string().optional().describe("Filter to notes under this vault-relative folder path."),
        limit: z.number().int().positive().max(100).optional().describe("Max results (default 10)."),
      },
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.searchNotes(engine, args)),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read Note",
      description:
        "Read a note's full content plus its graph context header (outlinks, backlinks, tags, frontmatter). Optionally read just one heading's section.",
      inputSchema: {
        path: z.string().describe("Note path, title, or alias."),
        heading: z.string().optional().describe("Only return the section under this heading."),
      },
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.readNote(engine, args)),
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Get Backlinks",
      description: "List every note that links to the given note, with the sentence/line each link appears in.",
      inputSchema: { path: z.string().describe("Note path, title, or alias.") },
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.getBacklinks(engine, args)),
  );

  server.registerTool(
    "get_neighborhood",
    {
      title: "Get Neighborhood",
      description:
        "Get the n-hop subgraph around a note: an explicit node list and edge list, treating links as undirected for hop counting.",
      inputSchema: {
        path: z.string().describe("Note path, title, or alias."),
        hops: z.number().int().positive().max(5).optional().describe("Hop radius (default 2)."),
      },
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.getNeighborhood(engine, args)),
  );

  server.registerTool(
    "get_context_bundle",
    {
      title: "Get Context Bundle",
      description:
        "The killer feature: given a topic (note path/title/alias, or a search phrase), pack the center note plus its most relevant 1-hop neighbors (prioritized by backlink count, then recency) into a token budget. Prefer this over read_note when you want broad context on a topic rather than just one note.",
      inputSchema: {
        topic: z.string().describe("Note path/title/alias, or a search phrase if no exact note matches."),
        tokenBudget: z.number().int().positive().optional().describe("Approximate token budget (default 4000)."),
      },
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.getContextBundle(engine, args)),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List Tags",
      description: "List the full tag hierarchy (including nested #parent/child tags) with note counts.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => textResult(tools.listTags(engine)),
  );

  server.registerTool(
    "get_notes_by_tag",
    {
      title: "Get Notes By Tag",
      description: "List every note carrying a given tag.",
      inputSchema: {
        tag: z.string().describe("Tag without the leading #, e.g. 'project/alpha'."),
        includeNested: z.boolean().optional().describe("Include notes tagged with nested children of this tag (default true)."),
      },
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.getNotesByTag(engine, args)),
  );

  server.registerTool(
    "find_path",
    {
      title: "Find Path",
      description:
        "Find the shortest connection path between two notes (links treated as undirected), with a one-line summary of each note along the way. Shows how two concepts are actually connected in the vault.",
      inputSchema: {
        from: z.string().describe("Starting note path, title, or alias."),
        to: z.string().describe("Destination note path, title, or alias."),
      },
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.findPath(engine, args)),
  );

  server.registerTool(
    "get_related",
    {
      title: "Get Related",
      description:
        "Recommend similar notes that are NOT directly linked to the given note, based on Jaccard similarity of shared tags and shared 1-hop neighbors. Use this to surface notes that probably should be linked but aren't yet.",
      inputSchema: {
        path: z.string().describe("Note path, title, or alias."),
        limit: z.number().int().positive().max(50).optional().describe("Max results (default 5)."),
      },
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.getRelated(engine, args)),
  );

  server.registerTool(
    "find_orphans",
    {
      title: "Find Orphans",
      description: "List notes with no outgoing or incoming links — useful for vault maintenance.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => textResult(tools.findOrphans(engine)),
  );

  server.registerTool(
    "find_unresolved",
    {
      title: "Find Unresolved Links",
      description: "List links that don't resolve to any note in the vault, grouped by target — useful for vault maintenance.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => textResult(tools.findUnresolved(engine)),
  );

  return server;
}

export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
