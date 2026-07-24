#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { diagnoseVault, formatDoctorReport, generateInitOutput, runDemo, type ClientName } from "./cli-commands.js";
import { connectStdio, createServer } from "./mcp/server.js";
import { VERSION } from "./version.js";
import { VaultEngine } from "./vault-engine.js";
import { writeToolsEnabledByDefault } from "./env.js";

function usage(): string {
  return `Obsidian Everywhere v${VERSION}

Usage:
  obsidian-everywhere <vault-path>              Start the MCP server
  obsidian-everywhere init <vault-path>         Generate client configuration
  obsidian-everywhere doctor <vault-path>       Check the vault and runtime
  obsidian-everywhere demo                      Try a safe built-in sample vault

Init options:
  --client all|codex|claude-code|claude-desktop (default: all)

Doctor options:
  --share                                       Redact the vault path for bug reports

Environment:
  OBSIDIAN_VAULT_PATH may replace <vault-path>.`;
}

import { resolveDbPath } from "./vault/db-path.js";

function resolveConfig(vaultArg?: string): { vaultDir: string; dbPath: string } {
  const vaultDir = process.env.OBSIDIAN_VAULT_PATH ?? vaultArg;
  if (!vaultDir) {
    throw new Error("Missing vault path.\n\n" + usage());
  }
  const resolvedVault = path.resolve(vaultDir);
  const dbPath = resolveDbPath(resolvedVault, "index-stdio.db");
  return { vaultDir: resolvedVault, dbPath };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "demo") {
    process.stdout.write(`${await runDemo()}\n`);
    return;
  }
  if (command === "init") {
    const clientIndex = args.indexOf("--client");
    const client = (clientIndex >= 0 ? args[clientIndex + 1] : "all") as ClientName;
    if (!(["all", "codex", "claude-code", "claude-desktop"] as string[]).includes(client)) {
      throw new Error(`Unknown client: ${client}`);
    }
    const positional = args.slice(1).filter((arg, index) => arg !== "--client" && args[index] !== "--client");
    const { vaultDir } = resolveConfig(positional[0]);
    process.stdout.write(`${generateInitOutput({ vaultDir, client })}\n`);
    return;
  }
  if (command === "doctor") {
    const vaultArg = args.slice(1).find((arg) => arg !== "--share");
    const { vaultDir } = resolveConfig(vaultArg);
    const report = await diagnoseVault(vaultDir);
    process.stdout.write(`${formatDoctorReport(report, { redactPaths: args.includes("--share") })}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const { vaultDir, dbPath } = resolveConfig(command);
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const engine = new VaultEngine({ vaultDir, dbPath });
  await engine.init();
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
