import type { Server } from "node:http";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultEngine } from "../vault-engine.js";
import { createHttpApp } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.resolve(here, "..", "..", "fixtures", "test-vault");
const TOKEN = "test-secret-token";

const JSONRPC_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

describe("Streamable HTTP transport (real listening server)", () => {
  let engine: VaultEngine;
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    engine = new VaultEngine({ vaultDir, dbPath: ":memory:" });
    await engine.init();
    const app = createHttpApp(engine, { bearerToken: TOKEN, gitMode: "read" });
    await new Promise<void>((resolve) => {
      httpServer = app.listen(0, () => resolve());
    });
    const address = httpServer.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await engine.close();
  });

  it("rejects requests with no bearer token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: JSONRPC_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with an invalid bearer token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, Authorization: "Bearer wrong-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("rate-limits repeated failed bearer authentication", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 35; index++) {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...JSONRPC_HEADERS, Authorization: "Bearer repeatedly-wrong" },
        body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "initialize", params: {} }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });

  it("reports healthy vault state without exposing indexed content", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, vaultState: "disabled", mountGuardEnabled: false });
  });

  it("runs initialize -> tools/list -> tools/call over real HTTP and manages Mcp-Session-Id", async () => {
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "curl-equivalent-test", version: "0.0.0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const initBody = await initRes.text();
    expect(initBody).toContain('"protocolVersion"');

    // MCP requires an "initialized" notification before further requests.
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.text();
    expect(listBody).toContain("vault_overview");
    expect(listBody).toContain("get_context_bundle");
    expect(listBody).toContain("git_status");
    expect(listBody).toContain("git_diff");
    expect(listBody).toContain("git_log");
    expect(listBody).not.toContain('"name":"git_commit"');

    const callRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": sessionId! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "vault_overview", arguments: {} },
      }),
    });
    expect(callRes.status).toBe(200);
    const callBody = await callRes.text();
    expect(callBody).toContain("Vault Overview");
    expect(callBody).toContain("Hub Note.md");

    // Session termination: DELETE ends it, further use of the same id is rejected.
    const deleteRes = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { ...JSONRPC_HEADERS, Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": sessionId! },
    });
    expect(deleteRes.status).toBeLessThan(300);

    const afterDeleteRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
    });
    expect(afterDeleteRes.status).toBe(404);
  });

  it("rejects a non-initialize request with no session id", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...JSONRPC_HEADERS, Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe("mount-aware health endpoint", () => {
  it("returns 503 without exposing vault content while a guarded mount is unavailable", async () => {
    const tmpVault = mkdtempSync(path.join(tmpdir(), "oe-http-mount-"));
    cpSync(vaultDir, tmpVault, { recursive: true });
    const engine = new VaultEngine({
      vaultDir: tmpVault,
      dbPath: ":memory:",
      mountGuard: { enabled: true, sentinel: ".obsidian/app.json", recheckIntervalMs: 60_000 },
    });
    let httpServer: Server | undefined;

    try {
      await engine.init();
      rmSync(tmpVault, { recursive: true, force: true });

      const app = createHttpApp(engine, { bearerToken: TOKEN });
      await new Promise<void>((resolve) => {
        httpServer = app.listen(0, () => resolve());
      });
      const address = httpServer.address();
      if (typeof address !== "object" || address === null) throw new Error("no address");

      const res = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        ok: false,
        vaultState: "unavailable",
        mountGuardEnabled: true,
      });
    } finally {
      if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      await engine.close();
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });
});
