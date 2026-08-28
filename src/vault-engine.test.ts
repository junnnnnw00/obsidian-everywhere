import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FSWatcher } from "chokidar";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const observedPaths: string[] = [];
    engine.watch((event) => observedPaths.push(event.path));
    const watcherBeforeRecovery = (engine as unknown as { watcher: FSWatcher }).watcher;
    await new Promise<void>((resolve) => watcherBeforeRecovery.once("ready", resolve));
    const closeBeforeRecovery = vi.spyOn(watcherBeforeRecovery, "close");
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
    const watcherAfterRecovery = (engine as unknown as { watcher: unknown }).watcher;
    expect(watcherAfterRecovery).not.toBe(watcherBeforeRecovery);
    expect(closeBeforeRecovery).toHaveBeenCalledTimes(1);

    // A watcher attached to the pre-unmount filesystem can look healthy but
    // never see later changes. Recovery must replace it, not only rescan once.
    writeFileSync(path.join(tmpVault, "Created after recovery.md"), "# After recovery");
    await vi.waitFor(
      () => {
        expect(engine?.db.getFileByPath("Created after recovery.md")).toBeDefined();
        expect(observedPaths).toContain("Created after recovery.md");
      },
      { timeout: 10_000, interval: 50 },
    );
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

describe("VaultEngine exact-file index recovery", () => {
  let tmpVault = "";
  let outsideDir = "";
  let engine: VaultEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
    if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects traversal and an in-vault directory symlink to an outside file", async () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-exact-recovery-"));
    outsideDir = mkdtempSync(path.join(tmpdir(), "oe-exact-outside-"));
    writeFileSync(path.join(tmpVault, "Inside.md"), "# Inside");
    writeFileSync(path.join(outsideDir, "outside.txt"), "must stay outside");
    symlinkSync(outsideDir, path.join(tmpVault, "escape"), process.platform === "win32" ? "junction" : "dir");

    engine = new VaultEngine({ vaultDir: tmpVault, dbPath: ":memory:" });
    await engine.init();

    expect(engine.indexExistingFileIfPresent("../outside.txt")).toBeUndefined();
    expect(engine.indexExistingFileIfPresent(path.join(outsideDir, "outside.txt"))).toBeUndefined();
    expect(engine.indexExistingFileIfPresent("escape/outside.txt")).toBeUndefined();
    expect(engine.db.getFileByPath("escape/outside.txt")).toBeUndefined();
  });

  it("uses actual disk casing instead of creating a duplicate DB identity", async () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-exact-recovery-"));
    writeFileSync(path.join(tmpVault, "final.pptx"), "presentation bytes");
    engine = new VaultEngine({ vaultDir: tmpVault, dbPath: ":memory:" });
    await engine.init();

    const alternateCaseExists = existsSync(path.join(tmpVault, "FINAL.PPTX"));
    const recovered = engine.indexExistingFileIfPresent("FINAL.PPTX");
    if (alternateCaseExists) expect(recovered?.path).toBe("final.pptx");
    else expect(recovered).toBeUndefined();
    expect(engine.db.getAllFiles().filter((file) => file.path.toLowerCase() === "final.pptx")).toHaveLength(1);
  });

  it("does not self-heal from disk while mount-guard considers the vault stale", async () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-exact-recovery-"));
    mkdirSync(path.join(tmpVault, ".obsidian"), { recursive: true });
    writeFileSync(path.join(tmpVault, ".obsidian", "app.json"), "{}");
    writeFileSync(path.join(tmpVault, "Initial.md"), "# Initial");
    engine = new VaultEngine({
      vaultDir: tmpVault,
      dbPath: ":memory:",
      mountGuard: { enabled: true, sentinel: ".obsidian/app.json", recheckIntervalMs: 60_000 },
    });
    await engine.init();

    writeFileSync(path.join(tmpVault, "late.txt"), "not while stale");
    rmSync(path.join(tmpVault, ".obsidian", "app.json"));
    expect((await engine.checkMountNow()).stale).toBe(true);
    expect(engine.indexExistingFileIfPresent("late.txt")).toBeUndefined();
    expect(engine.db.getFileByPath("late.txt")).toBeUndefined();
  });
});
