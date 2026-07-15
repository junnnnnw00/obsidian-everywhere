import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.resolve(here, "..", "fixtures", "test-vault");

function walkMarkdownFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  let files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === ".obsidian") continue;
      files = files.concat(walkMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

describe("fixture vault", () => {
  it("has at least 30 markdown notes (excluding .obsidian)", () => {
    const files = walkMarkdownFiles(vaultDir);
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it("includes Korean-named notes", () => {
    const files = walkMarkdownFiles(vaultDir);
    const hasKorean = files.some((f) => /[가-힣]/.test(path.basename(f)));
    expect(hasKorean).toBe(true);
  });
});
