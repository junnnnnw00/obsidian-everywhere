import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { VaultEngine } from "../vault-engine.js";
import { createServer, type CreateServerOptions } from "./server.js";

const tempRoots: string[] = [];
const isolatedGitConfigRoot = mkdtempSync(path.join(os.tmpdir(), "oe-mcp-git-config-test-"));
const isolatedGitConfig = path.join(isolatedGitConfigRoot, "config");
writeFileSync(isolatedGitConfig, "");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: isolatedGitConfig,
      LC_ALL: "C",
    },
  }).trim();
}

function createGitVault(): string {
  const vault = mkdtempSync(path.join(os.tmpdir(), "oe-mcp-git-test-"));
  tempRoots.push(vault);
  writeFileSync(path.join(vault, "Note.md"), "# Note\n\nInitial.\n");
  git(vault, ["init", "--template=", "--initial-branch=main"]);
  git(vault, ["config", "user.name", "OE Test"]);
  git(vault, ["config", "user.email", "oe@example.invalid"]);
  git(vault, ["add", "Note.md"]);
  git(vault, ["commit", "-m", "Initial"]);
  return vault;
}

async function connect(vault: string, options: CreateServerOptions): Promise<{ engine: VaultEngine; client: Client }> {
  const engine = new VaultEngine({ vaultDir: vault, dbPath: ":memory:" });
  await engine.init();
  const server = createServer(engine, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "git-test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { engine, client };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const text = result.content.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Missing text result");
  return text;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(isolatedGitConfigRoot, { recursive: true, force: true });
});

describe("Vault Git MCP tools", () => {
  it("keeps full-vault note access while Git is pinned to one nested repository", async () => {
    const vault = mkdtempSync(path.join(os.tmpdir(), "oe-mcp-nested-git-test-"));
    tempRoots.push(vault);
    const repository = path.join(vault, "DSLab");
    mkdirSync(repository);
    writeFileSync(path.join(vault, "Outside.md"), "# Outside\n\nWhole-vault context.\n");
    writeFileSync(path.join(repository, "Note.md"), "# Note\n\nInitial.\n");
    git(repository, ["init", "--template=", "--initial-branch=main"]);
    git(repository, ["config", "user.name", "OE Test"]);
    git(repository, ["config", "user.email", "oe@example.invalid"]);
    git(repository, ["add", "Note.md"]);
    git(repository, ["commit", "-m", "Initial"]);
    writeFileSync(path.join(repository, "Note.md"), "# Note\n\nChanged.\n");

    const { engine, client } = await connect(vault, { gitMode: "read", gitRepositoryPath: "DSLab" });
    const outside = await client.callTool({ name: "read_note", arguments: { path: "Outside.md" } });
    expect(textOf(outside as any)).toContain("Whole-vault context");
    const status = await client.callTool({ name: "git_status", arguments: {} });
    expect(textOf(status as any)).toContain("Repository: DSLab");
    expect(textOf(status as any)).toContain(" M Note.md");

    await client.close();
    await engine.close();
  });

  it("keeps Git absent by default and capability-gates commit/push", async () => {
    const vault = createGitVault();
    const cases: Array<[CreateServerOptions, string[]]> = [
      [{}, []],
      [{ gitMode: "read" }, ["git_diff", "git_log", "git_status"]],
      [{ gitMode: "commit", enableWriteTools: false }, ["git_diff", "git_log", "git_status"]],
      [{ gitMode: "commit", enableWriteTools: true }, ["git_commit", "git_diff", "git_log", "git_status"]],
      [
        {
          gitMode: "push",
          enableWriteTools: true,
          gitAllowedPushTargets: [{ remote: "origin", url: "https://example.invalid/vault.git" }],
        },
        ["git_commit", "git_diff", "git_log", "git_push", "git_status"],
      ],
    ];

    for (const [options, expected] of cases) {
      const { engine, client } = await connect(vault, options);
      const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith("git_"));
      expect(tools.map((tool) => tool.name).sort()).toEqual(expected);
      await client.close();
      await engine.close();
    }
  });

  it("publishes conservative MCP annotations", async () => {
    const vault = createGitVault();
    const { engine, client } = await connect(vault, {
      gitMode: "push",
      gitAllowedPushTargets: [{ remote: "origin", url: "https://example.invalid/vault.git" }],
    });
    const tools = (await client.listTools()).tools;
    for (const name of ["git_status", "git_diff", "git_log"]) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect(tools.find((tool) => tool.name === "git_commit")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tools.find((tool) => tool.name === "git_push")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    await client.close();
    await engine.close();
  });

  it("runs the preview/approval commit flow and rejects unknown schema keys", async () => {
    const vault = createGitVault();
    writeFileSync(path.join(vault, "Note.md"), "# Note\n\nChanged through MCP.\n");
    const { engine, client } = await connect(vault, { gitMode: "commit" });

    const status = await client.callTool({ name: "git_status", arguments: {} });
    expect(textOf(status as any)).toContain(" M Note.md");

    const invalid = await client.callTool({ name: "git_status", arguments: { command: "reset --hard" } });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid as any)).toMatch(/unrecognized key.*command/i);

    const preview = await client.callTool({
      name: "git_commit",
      arguments: { action: "preview", message: "docs: update note", paths: ["Note.md"] },
    });
    const previewText = textOf(preview as any);
    const approval = /Approval ID \(one use, 5 minutes\): ([0-9a-f-]{36})/.exec(previewText)?.[1];
    expect(approval).toBeTruthy();
    expect(git(vault, ["rev-list", "--count", "HEAD"])).toBe("1");

    const executed = await client.callTool({
      name: "git_commit",
      arguments: { action: "execute", approvalId: approval },
    });
    expect(executed.isError).not.toBe(true);
    expect(textOf(executed as any)).toContain("Vault Git Commit Created");
    expect(git(vault, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(git(vault, ["log", "-1", "--pretty=%s"])).toBe("docs: update note");

    const reused = await client.callTool({
      name: "git_commit",
      arguments: { action: "execute", approvalId: approval },
    });
    expect(reused.isError).toBe(true);
    expect(textOf(reused as any)).toMatch(/already used/i);

    await client.close();
    await engine.close();
  });

  it("blocks live Git reads and writes when mount-guard loses its sentinel", async () => {
    const vault = createGitVault();
    const sentinel = path.join(vault, ".mount-id");
    writeFileSync(sentinel, "vault identity\n");
    const engine = new VaultEngine({
      vaultDir: vault,
      dbPath: ":memory:",
      mountGuard: { enabled: true, sentinel: ".mount-id", recheckIntervalMs: 60_000 },
    });
    await engine.init();
    const server = createServer(engine, { gitMode: "commit" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "mount-git-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    unlinkSync(sentinel);

    const status = await client.callTool({ name: "git_status", arguments: {} });
    expect(status.isError).toBe(true);
    expect(textOf(status as any)).toMatch(/mount is unavailable/i);
    const commit = await client.callTool({
      name: "git_commit",
      arguments: { action: "preview", message: "blocked", paths: ["Note.md"] },
    });
    expect(commit.isError).toBe(true);
    expect(textOf(commit as any)).toMatch(/mount is unavailable/i);

    await client.close();
    await engine.close();
  });
});
