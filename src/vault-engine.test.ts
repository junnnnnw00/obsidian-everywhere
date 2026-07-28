import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VaultEngine } from "./vault-engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureVault = path.resolve(here, "..", "fixtures", "test-vault");

describe("VaultEngine mount guard", () => {
  let tmpVault = "";
  let engine: VaultEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
  });

  it("reports healthy status after guarded startup", async () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-mount-guard-"));
    cpSync(fixtureVault, tmpVault, { recursive: true });
    engine = new VaultEngine({
      vaultDir: tmpVault,
      dbPath: ":memory:",
      mountGuard: { enabled: true, sentinel: ".obsidian/app.json", recheckIntervalMs: 60_000 },
    });
    await engine.init();

    expect(engine.getStatus()).toMatchObject({
      mountGuardEnabled: true,
      mountState: "healthy",
      mountSentinel: ".obsidian/app.json",
      stale: false,
      writesAllowed: true,
    });
    expect(engine.writeBlockReason()).toBeNull();
  });

  it("preserves the index, blocks writes, and reconciles after a mount returns", async () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-mount-guard-"));
    cpSync(fixtureVault, tmpVault, { recursive: true });
    engine = new VaultEngine({
      vaultDir: tmpVault,
      dbPath: ":memory:",
      mountGuard: { enabled: true, sentinel: ".obsidian/app.json", recheckIntervalMs: 60_000 },
    });
    await engine.init();
    engine.watch();
    const indexedBefore = engine.getStatus().indexedNotes;

    rmSync(tmpVault, { recursive: true, force: true });
    expect((await engine.checkMountNow()).mountState).toBe("unavailable");
    expect(engine.getStatus().indexedNotes).toBe(indexedBefore);
    expect(engine.writeBlockReason()).toContain("writes are blocked");

    mkdirSync(path.join(tmpVault, ".obsidian"), { recursive: true });
    writeFileSync(path.join(tmpVault, ".obsidian", "app.json"), "{}");
    writeFileSync(path.join(tmpVault, "Restored.md"), "# Restored");

    const restored = await engine.checkMountNow();
    expect(restored).toMatchObject({
      mountState: "healthy",
      stale: false,
      writesAllowed: true,
      indexedNotes: 1,
    });
    expect(engine.db.getFileByPath("Restored.md")).toBeDefined();
    expect(engine.graph.consistencyCheck(engine.db).ok).toBe(true);
  });

  it("fails closed when a configured sentinel is missing", async () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-mount-guard-"));
    writeFileSync(path.join(tmpVault, "Looks-Populated.md"), "# Wrong mount");
    engine = new VaultEngine({
      vaultDir: tmpVault,
      dbPath: ":memory:",
      mountGuard: { enabled: true, sentinel: ".obsidian/app.json", recheckIntervalMs: 60_000 },
    });

    await expect(engine.init()).rejects.toThrow("sentinel is missing");
    expect(engine.getStatus().indexedNotes).toBe(0);
  });
});
