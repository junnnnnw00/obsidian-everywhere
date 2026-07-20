import { describe, expect, it } from "vitest";
import { resolveWithinVault, shouldExclude, toSafeVaultRelPath } from "./paths.js";

describe("toSafeVaultRelPath", () => {
  it("appends .md when missing", () => {
    expect(toSafeVaultRelPath("Projects/New Idea")).toBe("Projects/New Idea.md");
  });

  it("leaves an existing .md extension alone", () => {
    expect(toSafeVaultRelPath("Note A.md")).toBe("Note A.md");
  });

  it("rejects absolute unix paths", () => {
    expect(() => toSafeVaultRelPath("/etc/passwd")).toThrow(/absolute/);
  });

  it("rejects absolute windows-style paths", () => {
    expect(() => toSafeVaultRelPath("C:\\Windows\\system.ini")).toThrow(/absolute/);
  });

  it("rejects path traversal via ..", () => {
    expect(() => toSafeVaultRelPath("../../etc/passwd")).toThrow(/\.\.|traversal/i);
  });

  it("rejects path traversal buried in the middle of a path", () => {
    expect(() => toSafeVaultRelPath("Projects/../../../etc/passwd")).toThrow();
  });

  it("rejects writes into excluded directories", () => {
    expect(() => toSafeVaultRelPath(".obsidian/evil")).toThrow(/excluded/);
  });

  it("rejects an empty path", () => {
    expect(() => toSafeVaultRelPath("   ")).toThrow(/empty/);
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(toSafeVaultRelPath("Projects\\New Idea")).toBe("Projects/New Idea.md");
  });
});

describe("resolveWithinVault", () => {
  const vaultDir = "/Users/test/vault";

  it("resolves a normal relative path inside the vault", () => {
    expect(resolveWithinVault(vaultDir, "Note A.md")).toBe("/Users/test/vault/Note A.md");
  });

  it("resolves nested folders", () => {
    expect(resolveWithinVault(vaultDir, "Projects/New Idea.md")).toBe("/Users/test/vault/Projects/New Idea.md");
  });

  it("throws if a path somehow still resolves outside the vault", () => {
    // toSafeVaultRelPath should already prevent this upstream; this is defense in depth.
    expect(() => resolveWithinVault(vaultDir, "../outside.md")).toThrow(/escapes/);
  });
});

describe("shouldExclude", () => {
  it("excludes recoverable trash and atomic-write temporary files", () => {
    expect(shouldExclude(".trash/Old Note.md")).toBe(true);
    expect(shouldExclude("Folder/Note.md.oe-tmp-123")).toBe(true);
  });
});
