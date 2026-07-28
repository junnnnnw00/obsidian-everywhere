import { describe, expect, it } from "vitest";
import { waitForStableVaultListing } from "./wait-for-mount.js";

describe("waitForStableVaultListing", () => {
  it("resolves after one confirmation read when the listing is already stable", async () => {
    let sleeps = 0;
    await waitForStableVaultListing("/fake", {
      listDir: () => ["a.md", "b.md"],
      sleep: async () => {
        sleeps++;
      },
    });
    expect(sleeps).toBe(1);
  });

  it("treats a genuinely empty directory as stable, not an error", async () => {
    let sleeps = 0;
    await waitForStableVaultListing("/fake", {
      listDir: () => [],
      sleep: async () => {
        sleeps++;
      },
    });
    expect(sleeps).toBe(1);
  });

  it("rejects an empty listing after the timeout when requireNonEmpty is enabled", async () => {
    let clock = 0;
    await expect(
      waitForStableVaultListing("/external/vault", {
        requireNonEmpty: true,
        timeoutMs: 500,
        intervalMs: 100,
        now: () => clock,
        listDir: () => [],
        sleep: async () => {
          clock += 100;
        },
      }),
    ).rejects.toThrow("refusing to replace the existing index with an empty scan");
    expect(clock).toBeGreaterThanOrEqual(500);
  });

  it("waits for a non-empty stable listing when requireNonEmpty is enabled", async () => {
    const snapshots = [[], [], ["a.md"], ["a.md"]];
    let call = 0;
    await waitForStableVaultListing("/external/vault", {
      requireNonEmpty: true,
      listDir: () => snapshots[Math.min(call++, snapshots.length - 1)],
      sleep: async () => {},
    });
    expect(call).toBe(4);
  });

  it("keeps polling while the listing is still changing (a mount filling in)", async () => {
    const snapshots = [[], ["a.md"], ["a.md", "b.md"], ["a.md", "b.md"], ["a.md", "b.md"]];
    let call = 0;
    let sleeps = 0;
    await waitForStableVaultListing("/fake", {
      stableReads: 2,
      listDir: () => snapshots[Math.min(call++, snapshots.length - 1)],
      sleep: async () => {
        sleeps++;
      },
    });
    // First read (empty) + 3 more reads before two consecutive reads agree.
    expect(sleeps).toBe(3);
    expect(call).toBe(4);
  });

  it("gives up once timeoutMs elapses, even if the listing never stabilizes", async () => {
    let clock = 0;
    let call = 0;
    await waitForStableVaultListing("/fake", {
      timeoutMs: 1000,
      intervalMs: 100,
      now: () => clock,
      listDir: () => [`file-${call++}.md`],
      sleep: async () => {
        clock += 100;
      },
    });
    expect(clock).toBeGreaterThanOrEqual(1000);
    // Never hangs: stops after a bounded number of reads, not forever.
    expect(call).toBeLessThan(20);
  });
});
