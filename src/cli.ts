#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { connectStdio, createServer } from "./mcp/server.js";
import { VaultEngine } from "./vault-engine.js";
import { writeToolsEnabledByDefault } from "./env.js";

function resolveConfig(): { vaultDir: string; dbPath: string } {
  const vaultDir = process.env.OBSIDIAN_VAULT_PATH ?? process.argv[2];
  if (!vaultDir) {
    console.error("Usage: obsidian-everywhere <vault-path>   (or set OBSIDIAN_VAULT_PATH)");
    process.exit(1);
  }
  const resolvedVault = path.resolve(vaultDir);
  const dbPath = process.env.OBSIDIAN_EVERYWHERE_DB ?? path.join(resolvedVault, ".obsidian-everywhere", "index.db");
  return { vaultDir: resolvedVault, dbPath };
}

async function main(): Promise<void> {
  const { vaultDir, dbPath } = resolveConfig();
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const engine = new VaultEngine({ vaultDir, dbPath });
  engine.init();
  engine.watch();

  const server = createServer(engine, { enableWriteTools: writeToolsEnabledByDefault() });
  await connectStdio(server);

  const shutdown = async (): Promise<void> => {
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
