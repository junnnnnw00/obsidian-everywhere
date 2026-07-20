import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filesystemErrorMessage, writeFileAtomic } from "./write.js";

describe("atomic vault writes", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates parent folders and atomically replaces content", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oe-atomic-write-"));
    roots.push(root);
    const target = path.join(root, "Templates", "Album.md");
    writeFileAtomic(target, "first");
    writeFileAtomic(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  it("adds target-filesystem diagnostics to ENOSPC errors", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oe-enospc-"));
    roots.push(root);
    const error = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    const message = filesystemErrorMessage(error, path.join(root, "Album.md"));
    expect(message).toContain("ENOSPC while writing");
    expect(message).toContain("available on the target filesystem");
    expect(message).toContain("quota or inode limit");
  });
});
