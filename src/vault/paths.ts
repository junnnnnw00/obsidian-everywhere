import path from "node:path";

export const DEFAULT_EXCLUDE_DIRS = [".obsidian", ".git", ".trash", "node_modules", ".obsidian-everywhere"];

export function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

export function isMarkdownPath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(".md");
}

export function basenameNoExt(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const idx = base.lastIndexOf(".");
  return idx === -1 ? base : base.slice(0, idx);
}

export function extOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const idx = base.lastIndexOf(".");
  return idx === -1 ? "" : base.slice(idx + 1).toLowerCase();
}

/**
 * Any path segment starting with "." is excluded — not just the specific
 * names in `excludeDirs`. This covers OS/tool housekeeping files Obsidian
 * itself never shows (`.DS_Store`, `.git`), and, notably, the AppleDouble
 * sidecar files (`._Some Note.md`) macOS writes for every file on a
 * non-APFS/HFS+ volume (exFAT, FAT32 — the common case for external
 * drives): without this, those sidecars end up indexed as real notes,
 * since they end in `.md` but their content is binary resource-fork data.
 */
export function shouldExclude(relPath: string, excludeDirs: string[] = DEFAULT_EXCLUDE_DIRS): boolean {
  const segments = relPath.split("/");
  return segments.some((seg) => seg.startsWith(".") || excludeDirs.includes(seg) || seg.includes(".oe-tmp-"));
}

/**
 * Validates and normalizes a caller-supplied note path for write tools:
 * rejects absolute paths and `.`/`..` segments (path traversal), rejects
 * paths under excluded directories (e.g. `.obsidian`), and appends `.md`
 * if missing. Throws on anything invalid rather than silently coercing it,
 * since a write tool guessing wrong about the target path is worse than
 * failing loudly.
 */
export function toSafeVaultRelPath(requested: string): string {
  const trimmed = requested.trim();
  if (!trimmed) throw new Error("path must not be empty");

  let rel = trimmed.split("\\").join("/");
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
    throw new Error("path must be relative to the vault root, not absolute");
  }
  if (!isMarkdownPath(rel)) rel = `${rel}.md`;

  const segments = rel.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === "..")) {
    throw new Error("path must not contain '.' or '..' segments");
  }

  // NFC is the DB's canonical identity form (see index/scan.ts) — normalize
  // write targets the same way so a note written via one Unicode form is
  // found, not duplicated, by a later lookup using a different form.
  const normalized = segments.join("/").normalize("NFC");
  if (shouldExclude(normalized)) {
    throw new Error("path is inside an excluded directory (e.g. .obsidian)");
  }
  return normalized;
}

/**
 * Resolves a validated vault-relative path to an absolute filesystem path,
 * with a defense-in-depth check that it didn't escape `vaultDir`.
 */
export function resolveWithinVault(vaultDir: string, safeRelPath: string): string {
  const absVault = path.resolve(vaultDir);
  const absTarget = path.resolve(absVault, safeRelPath);
  if (absTarget !== absVault && !absTarget.startsWith(absVault + path.sep)) {
    throw new Error("resolved path escapes the vault");
  }
  return absTarget;
}
