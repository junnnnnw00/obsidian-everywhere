#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHttpApp } from "./http/app.js";
import { VaultEngine } from "./vault-engine.js";
import { writeToolsEnabledByDefault } from "./env.js";

function resolveConfig(): { vaultDir: string; dbPath: string; port: number; bearerToken: string } {
  const vaultDir = process.env.OBSIDIAN_VAULT_PATH ?? process.argv[2];
  if (!vaultDir) {
    console.error("Usage: obsidian-everywhere-http <vault-path>   (or set OBSIDIAN_VAULT_PATH)");
    process.exit(1);
  }
  const bearerToken = process.env.OBSIDIAN_EVERYWHERE_TOKEN;
  if (!bearerToken) {
    console.error("OBSIDIAN_EVERYWHERE_TOKEN must be set to a secret bearer token.");
    process.exit(1);
  }
  const resolvedVault = path.resolve(vaultDir);
  const dbPath =
    process.env.OBSIDIAN_EVERYWHERE_DB ?? path.join(resolvedVault, ".obsidian-everywhere", "index-http.db");
  const port = Number(process.env.PORT ?? 3737);
  return { vaultDir: resolvedVault, dbPath, port, bearerToken };
}

async function main(): Promise<void> {
  const { vaultDir, dbPath, port, bearerToken } = resolveConfig();
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });

  const engine = new VaultEngine({ vaultDir, dbPath });
  engine.init();
  engine.watch();

  const app = createHttpApp(engine, { bearerToken, enableWriteTools: writeToolsEnabledByDefault() });
  const httpServer = app.listen(port, () => {
    console.error(`obsidian-everywhere HTTP server listening on :${port} (vault: ${vaultDir})`);
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
