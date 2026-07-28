function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
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
