import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("replace_text makes a guarded partial edit", async () => {
    const result = textOf(
      (await client.callTool({
        name: "replace_text",
        arguments: { path: "Note D", find: "A freshly appended paragraph.", replace: "A safely replaced paragraph." },
      })) as any,
    );
    expect(result).toContain("Replaced 1 occurrence");
    expect(readFileSync(path.join(tmpVault, "Note D.md"), "utf8")).toContain("A safely replaced paragraph.");
  });

  it("patch_section replaces only the requested heading body", async () => {
    const result = textOf(
      (await client.callTool({
        name: "patch_section",
        arguments: { path: "Note B", heading: "Some Heading", content: "Completely new section text." },
      })) as any,
    );
    expect(result).toContain('Replaced section "Some Heading"');
    const onDisk = readFileSync(path.join(tmpVault, "Note B.md"), "utf8");
    expect(onDisk).toContain("Completely new section text.");
    expect(onDisk).toContain("## Another Heading");
    expect(onDisk).toContain("More content here");
  });

  it("updates and removes frontmatter fields without changing the body", async () => {
    const beforeBody = "Body stays exactly here.";
    await client.callTool({ name: "create_note", arguments: { path: "Metadata Edit", content: beforeBody } });
    const updated = textOf(
      (await client.callTool({
        name: "update_frontmatter",
        arguments: { path: "Metadata Edit", fields: { status: "active", score: 3 } },
      })) as any,
    );
    expect(updated).toContain("status, score");
    const removed = textOf(
      (await client.callTool({
        name: "remove_frontmatter_field",
        arguments: { path: "Metadata Edit", field: "score" },
      })) as any,
    );
    expect(removed).toContain('Removed frontmatter field "score"');
    const onDisk = readFileSync(path.join(tmpVault, "Metadata Edit.md"), "utf8");
    expect(onDisk).toContain("status: active");
    expect(onDisk).not.toContain("score:");
    expect(onDisk).toContain(beforeBody);
  });

  it("moves and renames a note while updating inbound links immediately", async () => {
    await client.callTool({ name: "create_note", arguments: { path: "Move Target", content: "Target body." } });
    await client.callTool({
      name: "create_note",
      arguments: {
        path: "Move Ref",
        content: "See [[Move Target#Details|the target]].\n\n`[[Move Target]]`\n\n```md\n[[Move Target]]\n```",
      },
    });
    const moved = textOf(
      (await client.callTool({
        name: "move_note",
        arguments: { from: "Move Target", to: "Archive/Move Target" },
      })) as any,
    );
    expect(moved).toContain("Moved Move Target.md to Archive/Move Target.md");
    const movedRef = readFileSync(path.join(tmpVault, "Move Ref.md"), "utf8");
    expect(movedRef).toContain("[[Archive/Move Target#Details|the target]]");
    expect(movedRef).toContain("`[[Move Target]]`");
    expect(movedRef).toContain("```md\n[[Move Target]]\n```");
    expect(existsSync(path.join(tmpVault, "Move Target.md"))).toBe(false);

    const renamed = textOf(
      (await client.callTool({
        name: "rename_note",
        arguments: { path: "Archive/Move Target", newName: "Renamed Target" },
      })) as any,
    );
    expect(renamed).toContain("Archive/Renamed Target.md");
    expect(readFileSync(path.join(tmpVault, "Move Ref.md"), "utf8")).toContain(
      "[[Archive/Renamed Target#Details|the target]]",
    );
  });

  it("delete_note refuses backlinks by default and otherwise uses recoverable vault trash", async () => {
    const refused = textOf(
      (await client.callTool({ name: "delete_note", arguments: { path: "Archive/Renamed Target" } })) as any,
    );
    expect(refused).toContain("backlink");
    const deleted = textOf(
      (await client.callTool({
        name: "delete_note",
        arguments: { path: "Archive/Renamed Target", force: true },
      })) as any,
    );
    expect(deleted).toContain("vault trash");
    expect(existsSync(path.join(tmpVault, "Archive", "Renamed Target.md"))).toBe(false);
    expect(existsSync(path.join(tmpVault, ".trash", "Archive", "Renamed Target.md"))).toBe(true);
  });

  it("bulk_replace defaults to dry-run and supports rollback after apply", async () => {
    await client.callTool({ name: "create_note", arguments: { path: "Bulk/A", content: "remove-callout here" } });
    await client.callTool({
      name: "create_note",
      arguments: { path: "Bulk/B", content: "remove-callout twice remove-callout" },
    });
    const preview = textOf(
      (await client.callTool({
        name: "bulk_replace",
        arguments: { folder: "Bulk", find: "remove-callout", replace: "clean" },
      })) as any,
    );
    expect(preview).toContain("Dry run: 3 replacement(s) in 2 file(s)");
    expect(readFileSync(path.join(tmpVault, "Bulk", "A.md"), "utf8")).toContain("remove-callout");

    const applied = textOf(
      (await client.callTool({
        name: "bulk_replace",
        arguments: { folder: "Bulk", find: "remove-callout", replace: "clean", dryRun: false },
      })) as any,
    );
    const rollbackId = /Rollback ID: ([A-Za-z0-9-]+)/.exec(applied)?.[1];
    expect(rollbackId).toBeTruthy();
    expect(readFileSync(path.join(tmpVault, "Bulk", "A.md"), "utf8")).toContain("clean");

    const rolledBack = textOf(
      (await client.callTool({ name: "rollback_bulk_edit", arguments: { rollbackId } })) as any,
    );
    expect(rolledBack).toContain("Restored 2 file(s)");
    expect(readFileSync(path.join(tmpVault, "Bulk", "A.md"), "utf8")).toContain("remove-callout");
  });

  it("reads and updates persisted Obsidian template/hotkey settings", async () => {
    const folderResult = textOf(
      (await client.callTool({ name: "set_templates_folder", arguments: { folder: "Templates" } })) as any,
    );
    expect(folderResult).toContain("Templates");
    const hotkeyResult = textOf(
      (await client.callTool({
        name: "set_hotkey",
        arguments: { commandId: "insert-template", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "N" }] },
      })) as any,
    );
    expect(hotkeyResult).toContain("insert-template");

    const settings = textOf((await client.callTool({ name: "get_obsidian_settings", arguments: {} })) as any);
    const hotkeys = textOf((await client.callTool({ name: "get_hotkeys", arguments: {} })) as any);
    expect(settings).toContain('"templateFolder": "Templates"');
    expect(hotkeys).toContain('"insert-template"');
  });
});
