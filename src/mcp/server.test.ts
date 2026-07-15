import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encode } from "gpt-tokenizer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultEngine } from "../vault-engine.js";
import { createServer } from "./server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.resolve(here, "..", "..", "fixtures", "test-vault");

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  if (!block?.text) throw new Error("tool result had no text content");
  return block.text;
}

describe("MCP stdio-layer tool server", () => {
  let engine: VaultEngine;
  let client: Client;

  beforeAll(async () => {
    engine = new VaultEngine({ vaultDir, dbPath: ":memory:" });
    engine.init();

    const server = createServer(engine);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await engine.close();
  });

  it("lists all 14 tools (12 read-only + 2 write, enabled by default)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "append_to_note",
      "create_note",
      "find_orphans",
      "find_path",
      "find_unresolved",
      "get_backlinks",
      "get_context_bundle",
      "get_neighborhood",
      "get_notes_by_tag",
      "get_related",
      "list_tags",
      "read_note",
      "search_notes",
      "vault_overview",
    ]);
    const writeToolNames = new Set(["create_note", "append_to_note"]);
    for (const t of tools) {
      if (writeToolNames.has(t.name)) {
        expect(t.annotations?.readOnlyHint).toBe(false);
        expect(t.annotations?.destructiveHint).toBe(true);
      } else {
        expect(t.annotations?.readOnlyHint).toBe(true);
      }
    }
  });

  it("vault_overview reports hub notes and tag distribution", async () => {
    const result = await client.callTool({ name: "vault_overview", arguments: {} });
    const text = textOf(result as any);
    expect(text).toContain("Vault Overview");
    expect(text).toContain("Hub Note.md");
  });

  it("search_notes finds notes by content and reports link/tag metadata", async () => {
    const result = await client.callTool({ name: "search_notes", arguments: { query: "hub" } });
    const text = textOf(result as any);
    expect(text).toContain("Hub Note.md");
    expect(text).toMatch(/links: \d+ out \/ \d+ in/);
  });

  it("read_note returns graph context header and body, and supports heading-scoped reads", async () => {
    const full = textOf((await client.callTool({ name: "read_note", arguments: { path: "Note B" } })) as any);
    expect(full).toContain("Graph Context");
    expect(full).toContain("Some Heading");
    expect(full).toContain("Another Heading");

    const scoped = textOf(
      (await client.callTool({ name: "read_note", arguments: { path: "Note B", heading: "Some Heading" } })) as any,
    );
    expect(scoped).toContain("Content under a heading");
    expect(scoped).not.toContain("More content here");
  });

  it("get_backlinks lists all sources linking to Hub Note", async () => {
    const text = textOf((await client.callTool({ name: "get_backlinks", arguments: { path: "Hub Note" } })) as any);
    expect(text).toContain("Backlink Test A.md");
    expect(text).toContain("Backlink Test B.md");
    expect(text).toContain("Backlink Test C.md");
    expect(text).toContain("Home.md");
  });

  it("get_neighborhood returns explicit node and edge lists", async () => {
    const text = textOf(
      (await client.callTool({ name: "get_neighborhood", arguments: { path: "Hub Note", hops: 1 } })) as any,
    );
    expect(text).toContain("## Nodes");
    expect(text).toContain("## Edges");
    expect(text).toContain("Backlink Test A.md");
  });

  it("get_context_bundle resolves an alias-referenced note via resolveNoteArg", async () => {
    const text = textOf(
      (await client.callTool({ name: "get_context_bundle", arguments: { topic: "Alt Name" } })) as any,
    );
    expect(text).toContain("Alias Source.md");
  });

  it("get_context_bundle respects its token budget (checked with a real BPE tokenizer)", async () => {
    const budget = 300;
    const text = textOf(
      (await client.callTool({
        name: "get_context_bundle",
        arguments: { topic: "Hub Note", tokenBudget: budget },
      })) as any,
    );
    const actualTokens = encode(text).length;
    // The tool's internal accounting uses a cheap chars/4 heuristic, not the
    // real BPE tokenizer, so allow slack — but it must still be in the same
    // ballpark as the requested budget, not silently unbounded.
    expect(actualTokens).toBeLessThan(budget * 1.5);
  });

  it("get_context_bundle includes more content under a larger budget", async () => {
    const small = textOf(
      (await client.callTool({
        name: "get_context_bundle",
        arguments: { topic: "Hub Note", tokenBudget: 120 },
      })) as any,
    );
    const large = textOf(
      (await client.callTool({
        name: "get_context_bundle",
        arguments: { topic: "Hub Note", tokenBudget: 4000 },
      })) as any,
    );
    expect(encode(large).length).toBeGreaterThan(encode(small).length);
  });

  it("list_tags renders a nested tag tree", async () => {
    const text = textOf((await client.callTool({ name: "list_tags", arguments: {} })) as any);
    expect(text).toContain("#project");
    expect(text).toMatch(/  +- #sub/);
  });

  it("get_notes_by_tag finds notes by nested tag", async () => {
    const text = textOf((await client.callTool({ name: "get_notes_by_tag", arguments: { tag: "project" } })) as any);
    expect(text).toContain("Nested Tag Child.md");
  });

  it("find_orphans lists the orphan fixture note", async () => {
    const text = textOf((await client.callTool({ name: "find_orphans", arguments: {} })) as any);
    expect(text).toContain("Orphan Note.md");
  });

  it("find_path finds the shortest undirected connection between two notes", async () => {
    const text = textOf(
      (await client.callTool({
        name: "find_path",
        arguments: { from: "Backlink Test A", to: "Backlink Test B" },
      })) as any,
    );
    expect(text).toContain("2 hops");
    expect(text).toContain("Hub Note.md");
  });

  it("find_path reports no connection for genuinely disconnected notes", async () => {
    const text = textOf(
      (await client.callTool({ name: "find_path", arguments: { from: "Orphan Note", to: "Hub Note" } })) as any,
    );
    expect(text).toContain("No connection found");
  });

  it("get_related surfaces tag-similar notes that aren't directly linked", async () => {
    const text = textOf(
      (await client.callTool({ name: "get_related", arguments: { path: "Frontmatter Test" } })) as any,
    );
    expect(text).toContain("Frontmatter Wikilink Test.md");
  });

  it("find_unresolved lists the unresolved fixture link", async () => {
    const text = textOf((await client.callTool({ name: "find_unresolved", arguments: {} })) as any);
    expect(text).toContain("Does Not Exist");
    expect(text).toContain("Unresolved Link Test.md");
  });
});
