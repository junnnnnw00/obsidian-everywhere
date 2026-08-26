import { normalizeGitRepositoryPath, type GitMode, type GitPushTarget } from "./git/vault-git.js";

export type { GitMode, GitPushTarget } from "./git/vault-git.js";

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export interface GitFeatureConfig {
  mode: GitMode;
  /** Vault-relative directory containing the repository; defaults to the vault root. */
  repositoryPath: string;
  allowedPushTargets: GitPushTarget[];
}

export interface MountGuardConfig {
  enabled: boolean;
  /** Optional vault-relative path that must exist while the intended mount is present. */
  sentinel?: string;
  recheckIntervalMs: number;
}

function positiveIntegerEnv(value: string | undefined, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function safeSentinel(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized) return undefined;
  if (/^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL must be a safe vault-relative path.");
  }
  return normalized;
}

/** All write tools are on by default; set OBSIDIAN_EVERYWHERE_READONLY=true to disable them. */
export function writeToolsEnabledByDefault(): boolean {
  return !isTruthyEnv(process.env.OBSIDIAN_EVERYWHERE_READONLY);
}

/** Opt in to the bundled multilingual transformer, which exceeds the default low-memory target. */
export function semanticSearchEnabledFromEnv(): boolean {
  return isTruthyEnv(process.env.OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC);
}

/**
 * Beta mount guard for removable drives, network shares, and container
 * mounts. The old REQUIRE_NONEMPTY variable remains as a compatibility alias.
 */
export function mountGuardConfigFromEnv(): MountGuardConfig {
  return {
    enabled:
      isTruthyEnv(process.env.OBSIDIAN_EVERYWHERE_MOUNT_GUARD) ||
      isTruthyEnv(process.env.OBSIDIAN_EVERYWHERE_REQUIRE_NONEMPTY_VAULT),
    sentinel: safeSentinel(process.env.OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL),
    recheckIntervalMs: positiveIntegerEnv(process.env.OBSIDIAN_EVERYWHERE_MOUNT_RECHECK_MS, 5000, 100),
  };
}

/** The OAuth (public connector) entrypoint inverts the default — write tools are off unless explicitly opted into. */
export function oauthWriteToolsEnabled(): boolean {
  return isTruthyEnv(process.env.OAUTH_ENABLE_WRITE_TOOLS);
}

/**
 * Vault Git integration is always explicit. The mode is capability-ordered:
 * off -> read (status/diff/log) -> commit -> push. Push additionally needs an
 * exact remote-name/HTTPS-URL mappings so enabling ordinary vault writes can
 * never accidentally publish history to a different endpoint.
 */
export function gitFeatureConfigFromEnv(): GitFeatureConfig {
  const rawMode = (process.env.OBSIDIAN_EVERYWHERE_GIT_MODE ?? "off").trim().toLowerCase();
  if (!(rawMode === "off" || rawMode === "read" || rawMode === "commit" || rawMode === "push")) {
    throw new Error("OBSIDIAN_EVERYWHERE_GIT_MODE must be one of: off, read, commit, push.");
  }
  const entries = (process.env.OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const targets = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(
        "OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES entries must use remote=https://host/path.git syntax.",
      );
    }
    const remote = entry.slice(0, separator).trim();
    const rawUrl = entry.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote)) {
      throw new Error(`Invalid remote name in OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES: ${remote}`);
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Push target '${remote}' must be an absolute credential-free HTTPS URL.`);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(
        `Push target '${remote}' must be an absolute credential-free HTTPS URL without query or fragment.`,
      );
    }
    const url = parsed.href;
    const existing = targets.get(remote);
    if (existing && existing !== url) throw new Error(`Push target '${remote}' is configured more than once.`);
    targets.set(remote, url);
  }
  const allowedPushTargets = [...targets].map(([remote, url]) => ({ remote, url }));
  if (rawMode === "push" && allowedPushTargets.length === 0) {
    throw new Error(
      "OBSIDIAN_EVERYWHERE_GIT_MODE=push requires OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES (for example: origin=https://github.com/owner/vault.git).",
    );
  }
  const repositoryPath = normalizeGitRepositoryPath(process.env.OBSIDIAN_EVERYWHERE_GIT_REPO_PATH);
  return { mode: rawMode, repositoryPath, allowedPushTargets };
}
