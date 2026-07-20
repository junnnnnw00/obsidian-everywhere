import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseVault, formatDoctorReport, generateInitOutput, runDemo } from "./cli-commands.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("growth CLI commands", () => {
  it("generates copyable client configuration without changing settings", () => {
    const output = generateInitOutput({ vaultDir: "/tmp/My Vault", client: "all" });
    expect(output).toContain("codex mcp add obsidian-everywhere");
    expect(output).toContain("claude mcp add obsidian-everywhere");
    expect(output).toContain('"mcpServers"');
    expect(output).toContain("No client configuration files were changed");
  });

  it("diagnoses a real temporary vault without exposing note content", async () => {
    const vaultDir = mkdtempSync(path.join(os.tmpdir(), "oe-doctor-"));
    tempDirs.push(vaultDir);
    mkdirSync(path.join(vaultDir, ".obsidian"));
    writeFileSync(path.join(vaultDir, "Private.md"), "secret phrase [[Missing]]\n");
    const report = await diagnoseVault(vaultDir);
    const text = formatDoctorReport(report);
    expect(report.ok).toBe(true);
    expect(report.noteCount).toBe(1);
    expect(report.unresolvedCount).toBe(1);
    expect(text).not.toContain("secret phrase");
    expect(formatDoctorReport(report, { redactPaths: true })).not.toContain(vaultDir);
  });

  it("runs a self-contained dry-run demo", async () => {
    const output = await runDemo();
    expect(output).toContain("$ vault_overview");
    expect(output).toContain("$ find_unresolved");
    expect(output).toContain("$ bulk_replace (dry-run)");
    expect(output).toContain("Missing Research");
    expect(output).toContain("Your files were not used or changed");
  });
});
