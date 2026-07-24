import { readdirSync } from "node:fs";

export interface WaitForStableVaultListingOptions {
  /** Max total time to wait for the listing to stop changing, in ms. */
  timeoutMs?: number;
  /** Delay between listing attempts, in ms. */
  intervalMs?: number;
  /** Consecutive matching listings required before considering it stable. */
  stableReads?: number;
  /** Injectable for tests; defaults to a real top-level readdirSync. */
  listDir?: (dir: string) => string[];
  /** Injectable for tests; defaults to a real timer-based delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.OBSIDIAN_EVERYWHERE_MOUNT_WAIT_MS ?? 5000);
const DEFAULT_INTERVAL_MS = Number(process.env.OBSIDIAN_EVERYWHERE_MOUNT_POLL_MS ?? 200);
const DEFAULT_STABLE_READS = 2;

function defaultListDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameEntries(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Waits for a directory's top-level listing to stop changing between reads.
 * A freshly-attached external or network volume can briefly expose a
 * partial listing (only dotfiles, or nothing at all) before the OS finishes
 * mounting it; a vault scan that runs during that window silently indexes a
 * near-empty vault instead of failing loudly. This blocks — briefly, by
 * default — until consecutive reads agree, or `timeoutMs` elapses; it never
 * blocks indefinitely, and a directory that is genuinely stable on the
 * first read (the common case) returns after one extra confirmation read.
 */
export async function waitForStableVaultListing(
  dir: string,
  options: WaitForStableVaultListingOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const stableReads = Math.max(2, options.stableReads ?? DEFAULT_STABLE_READS);
  const listDir = options.listDir ?? defaultListDir;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const deadline = now() + timeoutMs;
  let previous = listDir(dir);
  let matches = 1;

  while (matches < stableReads) {
    if (now() >= deadline) return;
    await sleep(intervalMs);
    const current = listDir(dir);
    if (sameEntries(previous, current)) {
      matches++;
    } else {
      matches = 1;
      previous = current;
    }
  }
}
