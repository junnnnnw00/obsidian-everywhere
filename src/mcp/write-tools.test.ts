import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultEngine } from "../vault-engine.js";
import { createServer } from "./server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureVault = path.resolve(here, "..", "..", "fixtures", "test-vault");

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  if (!block?.text) throw new Error("tool result had no text content");
  return block.text;
}

describe("write tools (create_note, append_to_note) — isolated writable vault copy", () => {
  let tmpVault: string;
  let engine: VaultEngine;
  let client: Client;

  beforeAll(async () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-write-tools-"));
    cpSync(fixtureVault, tmpVault, { recursive: true });

    engine = new VaultEngine({ vaultDir: tmpVault, dbPath: ":memory:" });
    engine.init(); // no .watch() — write tools reindex synchronously via engine.indexFileNow

    const server = createServer(engine); // write tools enabled by default
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "write-tools-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await engine.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it("create_note writes a real file and is queryable immediately (no watcher needed)", async () => {
    const created = textOf(
      (await client.callTool({
        name: "create_note",
        arguments: { path: "New Idea", content: "Links to [[Note A]].", frontmatter: { tags: ["idea"] } },
      })) as any,
    );
    expect(created).toContain("Created New Idea.md");
    expect(created).toContain("Outlinks (1)");
    expect(created).toContain("[[Note A.md]]");

    const onDisk = readFileSync(path.join(tmpVault, "New Idea.md"), "utf8");
    expect(onDisk).toContain("tags:");
    expect(onDisk).toContain("Links to [[Note A]].");

    const backlinks = textOf((await client.callTool({ name: "get_backlinks", arguments: { path: "Note A" } })) as any);
    expect(backlinks).toContain("New Idea.md");

    const search = textOf((await client.callTool({ name: "search_notes", arguments: { tag: "idea" } })) as any);
    expect(search).toContain("New Idea.md");
  });

  it("create_note refuses to overwrite an existing note without overwrite: true", async () => {
    const result = textOf(
      (await client.callTool({ name: "create_note", arguments: { path: "New Idea", content: "clobber" } })) as any,
    );
    expect(result).toContain("already exists");
    expect(readFileSync(path.join(tmpVault, "New Idea.md"), "utf8")).toContain("Links to [[Note A]].");
  });

  it("create_note overwrites when overwrite: true is passed", async () => {
    const result = textOf(
      (await client.callTool({
        name: "create_note",
        arguments: { path: "New Idea", content: "Replaced content.", overwrite: true },
      })) as any,
    );
    expect(result).toContain("Created New Idea.md");
    expect(readFileSync(path.join(tmpVault, "New Idea.md"), "utf8")).toContain("Replaced content.");
  });

  it("create_note rejects path traversal", async () => {
    const result = textOf(
      (await client.callTool({ name: "create_note", arguments: { path: "../../etc/evil", content: "x" } })) as any,
    );
    expect(result).toMatch(/Error/i);
  });

  it("append_to_note appends to the end of the file by default", async () => {
    const result = textOf(
      (await client.callTool({
        name: "append_to_note",
        arguments: { path: "Note D", content: "A freshly appended paragraph." },
      })) as any,
    );
    expect(result).toContain("Appended to Note D.md");
    const onDisk = readFileSync(path.join(tmpVault, "Note D.md"), "utf8");
    expect(onDisk.trim().endsWith("A freshly appended paragraph.")).toBe(true);
  });

  it("append_to_note inserts under a specific heading, before the next heading", async () => {
    const result = textOf(
      (await client.callTool({
        name: "append_to_note",
        arguments: { path: "Note B", content: "Inserted under Some Heading.", heading: "Some Heading" },
      })) as any,
    );
    expect(result).toContain('under heading "Some Heading"');

    const onDisk = readFileSync(path.join(tmpVault, "Note B.md"), "utf8");
    const someHeadingIdx = onDisk.indexOf("## Some Heading");
    const insertedIdx = onDisk.indexOf("Inserted under Some Heading.");
    const anotherHeadingIdx = onDisk.indexOf("## Another Heading");
    expect(someHeadingIdx).toBeGreaterThan(-1);
    expect(insertedIdx).toBeGreaterThan(someHeadingIdx);
    expect(insertedIdx).toBeLessThan(anotherHeadingIdx);
  });

  it("append_to_note fails without writing anything if the heading doesn't exist", async () => {
    const before = readFileSync(path.join(tmpVault, "Note C.md"), "utf8");
    const result = textOf(
      (await client.callTool({
        name: "append_to_note",
        arguments: { path: "Note C", content: "should not appear", heading: "Nonexistent Heading" },
      })) as any,
    );
    expect(result).toMatch(/not found/i);
    expect(readFileSync(path.join(tmpVault, "Note C.md"), "utf8")).toBe(before);
  });

  it("append_to_note reports an error for a note that doesn't exist, without creating it", async () => {
    const result = textOf(
      (await client.callTool({
        name: "append_to_note",
        arguments: { path: "Does Not Exist At All", content: "x" },
      })) as any,
    );
    expect(result).toMatch(/not found/i);
  });
});
