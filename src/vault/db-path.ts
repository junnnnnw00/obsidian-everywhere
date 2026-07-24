import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Resolves the SQLite DB file path for a vault.
 * If OBSIDIAN_EVERYWHERE_DB is set in environment, that takes highest priority.
 * If the vault is located on an external volume (e.g. /Volumes/...), defaults
 * to storing the SQLite DB in ~/.obsidian-everywhere/ to ensure high-performance
 * SQLite WAL operations regardless of external drive filesystem (exFAT, FAT32, etc.).
 */
export function resolveDbPath(vaultDir: string, defaultFilename: string): string {
  if (process.env.OBSIDIAN_EVERYWHERE_DB) {
    return process.env.OBSIDIAN_EVERYWHERE_DB;
  }
  const resolvedVault = path.resolve(vaultDir);
  const isExternalVolume = resolvedVault.startsWith("/Volumes/");

  if (isExternalVolume) {
    const hash = crypto.createHash("sha256").update(resolvedVault).digest("hex").slice(0, 12);
    const safeName = path.basename(resolvedVault).replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(os.homedir(), ".obsidian-everywhere", `${safeName}-${hash}-${defaultFilename}`);
  }

  return path.join(resolvedVault, ".obsidian-everywhere", defaultFilename);
}
