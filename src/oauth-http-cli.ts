#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createOAuthHttpApp } from "./oauth/http-app.js";
import { VaultEngine } from "./vault-engine.js";

function resolveConfig(): { vaultDir: string; dbPath: string; port: number; issuerUrl: URL; loginSecret: string } {
  const vaultDir = process.env.OBSIDIAN_VAULT_PATH ?? process.argv[2];
  if (!vaultDir) {
    console.error("Usage: obsidian-everywhere-oauth-http <vault-path>   (or set OBSIDIAN_VAULT_PATH)");
    process.exit(1);
  }
  const issuer = process.env.OAUTH_ISSUER_URL;
  if (!issuer) {
    console.error("OAUTH_ISSUER_URL must be set to this server's public HTTPS origin (e.g. https://obsidian.example.com).");
    process.exit(1);
  }
  const loginSecret = process.env.OAUTH_LOGIN_SECRET;
  if (!loginSecret) {
    console.error("OAUTH_LOGIN_SECRET must be set to a secret string used as the single-user login credential.");
    process.exit(1);
  }
  const resolvedVault = path.resolve(vaultDir);
  const dbPath = process.env.OBSIDIAN_EVERYWHERE_DB ?? path.join(resolvedVault, ".obsidian-everywhere", "index.db");
  const port = Number(process.env.PORT ?? 3738);
  return { vaultDir: resolvedVault, dbPath, port, issuerUrl: new URL(issuer), loginSecret };
}

async function main(): Promise<void> {
  const { vaultDir, dbPath, port, issuerUrl, loginSecret } = resolveConfig();
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });

  const engine = new VaultEngine({ vaultDir, dbPath });
  engine.init();
  engine.watch();

  const app = createOAuthHttpApp(engine, { issuerUrl, loginSecret });
  const httpServer = app.listen(port, () => {
    console.error(`obsidian-everywhere OAuth HTTP server listening on :${port} (issuer: ${issuerUrl}, vault: ${vaultDir})`);
    console.error("This process must sit behind a reverse proxy (e.g. Cloudflare Tunnel) that terminates HTTPS at the issuer URL.");
  });

  const shutdown = async (): Promise<void> => {
    httpServer.close();
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
