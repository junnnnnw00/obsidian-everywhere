import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultEngine } from "../vault-engine.js";
import { createOAuthHttpApp } from "./http-app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.resolve(here, "..", "..", "fixtures", "test-vault");
const LOGIN_SECRET = "correct-horse-battery-staple";
const REDIRECT_URI = "http://localhost:9999/callback";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(options: { method: string; url: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(options.url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: options.method, headers: options.headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("could not allocate a free port"));
      }
    });
    srv.on("error", reject);
  });
}

describe("OAuth 2.1 flow (PKCE + Dynamic Client Registration) — real HTTP, local e2e", () => {
  let engine: VaultEngine;
  let httpServer: http.Server;
  let issuerUrl: string;

  beforeAll(async () => {
    engine = new VaultEngine({ vaultDir, dbPath: ":memory:" });
    engine.init();
    const port = await getFreePort();
    issuerUrl = `http://127.0.0.1:${port}`;
    const app = createOAuthHttpApp(engine, { issuerUrl: new URL(issuerUrl), loginSecret: LOGIN_SECRET });
    httpServer = app.listen(port);
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await engine.close();
  });

  it("publishes authorization-server and protected-resource discovery metadata", async () => {
    const asMeta = await rawRequest({ method: "GET", url: `${issuerUrl}/.well-known/oauth-authorization-server` });
    expect(asMeta.status).toBe(200);
    const asJson = JSON.parse(asMeta.body);
    expect(asJson.authorization_endpoint).toBe(`${issuerUrl}/authorize`);
    expect(asJson.token_endpoint).toBe(`${issuerUrl}/token`);
    expect(asJson.registration_endpoint).toBe(`${issuerUrl}/register`);

    const rsMeta = await rawRequest({ method: "GET", url: `${issuerUrl}/.well-known/oauth-protected-resource/mcp` });
    expect(rsMeta.status).toBe(200);
    const rsJson = JSON.parse(rsMeta.body);
    expect(rsJson.resource).toBe(`${issuerUrl}/mcp`);
  });

  it("returns 401 with a WWW-Authenticate discovery pointer for an unauthenticated /mcp request", async () => {
    const res = await rawRequest({
      method: "POST",
      url: `${issuerUrl}/mcp`,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("oauth-protected-resource");
  });

  it("runs the full authorize -> login -> token -> protected tools/call flow end to end", async () => {
    // 1. Dynamic Client Registration
    const reg = await rawRequest({
      method: "POST",
      url: `${issuerUrl}/register`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(reg.status).toBe(201);
    const client = JSON.parse(reg.body);
    expect(client.client_id).toBeTruthy();

    // 2. PKCE
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    // 3. Authorization request -> our single-user login form
    const authorizeUrl = new URL(`${issuerUrl}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "xyz123");
    authorizeUrl.searchParams.set("scope", "mcp:tools");

    const authorizePage = await rawRequest({ method: "GET", url: authorizeUrl.toString() });
    expect(authorizePage.status).toBe(200);
    expect(authorizePage.body).toContain("Connector secret");
    const authzIdMatch = authorizePage.body.match(/name="authzId" value="([^"]+)"/);
    expect(authzIdMatch).not.toBeNull();
    const authzId = authzIdMatch![1]!;

    // 4a. Wrong secret is rejected without consuming... (one-shot: this specific attempt is burned)
    const wrongLogin = await rawRequest({
      method: "POST",
      url: `${issuerUrl}/login`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ authzId, secret: "not-the-secret" }).toString(),
    });
    expect(wrongLogin.status).toBe(401);
    expect(wrongLogin.body).toContain("Incorrect secret");

    // 4b. Get a fresh authzId and log in with the correct secret this time.
    const authorizePage2 = await rawRequest({ method: "GET", url: authorizeUrl.toString() });
    const authzId2 = authorizePage2.body.match(/name="authzId" value="([^"]+)"/)![1]!;
    const login = await rawRequest({
      method: "POST",
      url: `${issuerUrl}/login`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ authzId: authzId2, secret: LOGIN_SECRET }).toString(),
    });
    expect(login.status).toBe(302);
    const location = new URL(login.headers.location!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("xyz123");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    // 5. Exchange the authorization code for tokens
    const tokenRes = await rawRequest({
      method: "POST",
      url: `${issuerUrl}/token`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = JSON.parse(tokenRes.body);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.token_type.toLowerCase()).toBe("bearer");

    // 6. Use the access token against the protected MCP endpoint
    const initRes = await rawRequest({
      method: "POST",
      url: `${issuerUrl}/mcp`,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "oauth-e2e-test", version: "0.0.0" } },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers["mcp-session-id"] as string;
    expect(sessionId).toBeTruthy();

    await rawRequest({
      method: "POST",
      url: `${issuerUrl}/mcp`,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Mcp-Session-Id": sessionId,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const callRes = await rawRequest({
      method: "POST",
      url: `${issuerUrl}/mcp`,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Mcp-Session-Id": sessionId,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vault_overview", arguments: {} } }),
    });
    expect(callRes.status).toBe(200);
    expect(callRes.body).toContain("Vault Overview");
    expect(callRes.body).toContain("Hub Note.md");

    // An invalid/expired token must still be rejected.
    const badTokenRes = await rawRequest({
      method: "POST",
      url: `${issuerUrl}/mcp`,
      headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(badTokenRes.status).toBe(401);
  });
});
