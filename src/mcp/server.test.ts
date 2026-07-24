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
    await engine.init();

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

  it("lists all read and write tools (enabled by default)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "append_to_note",
      "bulk_replace",
      "create_note",
      "delete_note",
      "find_orphans",
      "find_path",
      "find_unresolved",
      "get_backlinks",
      "get_context_bundle",
      "get_hotkeys",
      "get_neighborhood",
      "get_notes_by_tag",
      "get_obsidian_settings",
      "get_related",
      "list_folder",
      "list_notes",
      "list_tags",
      "move_note",
      "patch_section",
      "read_note",
      "regex_search",
      "remove_frontmatter_field",
      "rename_note",
      "replace_text",
      "rollback_bulk_edit",
      "search_notes",
      "set_hotkey",
      "set_templates_folder",
      "update_frontmatter",
      "validate_base",
      "vault_overview",
    ]);
    const writeToolNames = new Set([
      "append_to_note",
      "bulk_replace",
      "create_note",
      "delete_note",
      "move_note",
      "patch_section",
      "remove_frontmatter_field",
      "rename_note",
      "replace_text",
      "rollback_bulk_edit",
      "set_hotkey",
      "set_templates_folder",
      "update_frontmatter",
    ]);
    for (const t of tools) {
      if (writeToolNames.has(t.name)) {
        expect(t.annotations?.readOnlyHint).toBe(false);
      } else {
        expect(t.annotations?.readOnlyHint).toBe(true);
        expect(t.annotations?.destructiveHint).toBe(false);
        expect(t.annotations?.idempotentHint).toBe(true);
      }
      expect(t.annotations?.openWorldHint).toBe(false);
    }
    expect(tools.find((tool) => tool.name === "append_to_note")?.annotations?.destructiveHint).toBe(false);
    expect(tools.find((tool) => tool.name === "delete_note")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((tool) => tool.name === "patch_section")?.annotations?.idempotentHint).toBe(true);
    expect(tools.find((tool) => tool.name === "set_hotkey")?.annotations?.idempotentHint).toBe(true);
  });

  it("advertises server-wide tool guidance during MCP initialization", () => {
    expect(client.getInstructions()).toContain("vault_overview");
    expect(client.getInstructions()).toContain("confirm that the user intends to modify the vault");
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

  it("lists notes explicitly and supports regex search", async () => {
    const folder = textOf((await client.callTool({ name: "list_folder", arguments: { folder: "Folder1" } })) as any);
    expect(folder).toContain("Folder1/Same Name.md (note)");
    const listed = textOf(
      (await client.callTool({ name: "list_notes", arguments: { folder: "Folder1", recursive: false } })) as any,
    );
    expect(listed).toContain("Folder1/Same Name.md");
    const regex = textOf(
      (await client.callTool({ name: "regex_search", arguments: { pattern: "한글.*노트", flags: "i" } })) as any,
    );
    expect(regex).toContain("한글");
  });

  it("read_note returns graph context header and body, and supports heading-scoped reads", async () => {
    const fullResult = (await client.callTool({ name: "read_note", arguments: { path: "Note B" } })) as any;
    const full = textOf(fullResult);
    expect(full).toContain("Graph Context");
    expect(full).toContain("Some Heading");
    expect(full).toContain("Another Heading");
    expect(fullResult.structuredContent).toMatchObject({
      path: "Note B.md",
      frontmatter: expect.any(Object),
      outlinks: expect.any(Array),
      backlinks: expect.any(Array),
      tags: expect.any(Array),
      pagination: { hasMore: false },
    });

    const page = (await client.callTool({
      name: "read_note",
      arguments: { path: "Note B", offset: 0, limit: 1 },
    })) as any;
    expect(page.structuredContent.pagination).toMatchObject({ returnedLines: 1, hasMore: true, nextOffset: 1 });

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

  it("statically validates Base YAML and reports live-rendering limits", async () => {
    const text = textOf(
      (await client.callTool({
        name: "validate_base",
        arguments: { content: "views:\n  - type: table\n    name: Test" },
      })) as any,
    );
    expect(text).toContain('"valid": true');
    expect(text).toContain("live Obsidian app");
  });
});
