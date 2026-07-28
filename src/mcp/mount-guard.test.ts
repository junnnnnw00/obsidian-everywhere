import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VaultEngine } from "../vault-engine.js";
import { createServer } from "./server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureVault = path.resolve(here, "..", "..", "fixtures", "test-vault");

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("MCP write guard during mount loss", () => {
  let tmpVault = "";
  let engine: VaultEngine | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await engine?.close();
    if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
  });

  it("keeps indexed reads available but blocks every guarded write", async () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-mcp-mount-guard-"));
    cpSync(fixtureVault, tmpVault, { recursive: true });
    engine = new VaultEngine({
      vaultDir: tmpVault,
      dbPath: ":memory:",
      mountGuard: { enabled: true, sentinel: ".obsidian/app.json", recheckIntervalMs: 60_000 },
    });
    await engine.init();

    const server = createServer(engine);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "mount-guard-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    rmSync(tmpVault, { recursive: true, force: true });

    const write = await client.callTool({
      name: "create_note",
      arguments: { path: "Must Not Exist", content: "blocked" },
    });
    expect(textOf(write as any)).toContain("writes are blocked");
    expect(write.isError).toBe(true);

    const status = await client.callTool({ name: "vault_status", arguments: {} });
    expect(textOf(status as any)).toContain("unavailable");

    const search = await client.callTool({ name: "search_notes", arguments: { query: "hub" } });
    expect(textOf(search as any)).toContain("Hub Note.md");
  });
});
