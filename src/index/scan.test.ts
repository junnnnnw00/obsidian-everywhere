import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { VaultDB } from "./db.js";
import { fullScan } from "./scan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultDir = path.resolve(here, "..", "..", "fixtures", "test-vault");

describe("fullScan against fixture vault", () => {
  let db: VaultDB;

  beforeAll(() => {
    db = new VaultDB(":memory:");
    fullScan(db, vaultDir);
  });

  it("excludes .obsidian/ from indexing", () => {
    expect(db.getFileByPath(".obsidian/app.json")).toBeUndefined();
  });

  it("indexes at least 30 markdown notes plus the attachment", () => {
    const files = db.getAllFiles();
    const md = files.filter((f) => f.is_markdown === 1);
    expect(md.length).toBeGreaterThanOrEqual(30);
    expect(db.getFileByPath("Attachments/diagram.png")).toBeDefined();
  });

  it("resolves a plain wikilink", () => {
    const outlinks = db.getOutlinks("Note A.md");
    const toNoteB = outlinks.find((l) => l.targetRaw === "Note B");
    expect(toNoteB?.targetPath).toBe("Note B.md");
  });

  it("resolves an alias link", () => {
    const outlinks = db.getOutlinks("Alias Link Test.md");
    const link = outlinks.find((l) => l.targetRaw === "Alt Name");
    expect(link?.targetPath).toBe("Alias Source.md");
  });

  it("keeps unresolved links in the graph with null target", () => {
    const outlinks = db.getOutlinks("Unresolved Link Test.md");
    const link = outlinks.find((l) => l.targetRaw === "Does Not Exist");
    expect(link).toBeDefined();
    expect(link?.targetPath).toBeNull();

    const unresolved = db.findUnresolved();
    expect(unresolved.some((u) => u.targetRaw === "Does Not Exist")).toBe(true);
  });

  it("distinguishes embed links from wikilinks", () => {
    const outlinks = db.getOutlinks("Embed Test.md");
    expect(outlinks.find((l) => l.targetRaw === "Note A")?.type).toBe("embed");
    expect(outlinks.find((l) => l.targetRaw === "diagram.png")?.targetPath).toBe("Attachments/diagram.png");
  });

  it("resolves markdown links and ignores external/broken ones appropriately", () => {
    const outlinks = db.getOutlinks("Markdown Link Test.md");
    expect(outlinks.find((l) => l.targetRaw === "Note B.md")?.targetPath).toBe("Note B.md");
    expect(outlinks.find((l) => l.targetRaw === "Note C.md")?.targetPath).toBe("Note C.md");
    const broken = outlinks.find((l) => l.targetRaw === "Nonexistent File.md");
    expect(broken?.targetPath).toBeNull();
    expect(outlinks.some((l) => l.targetRaw.includes("example.com"))).toBe(false);
  });

  it("ignores wikilinks inside code blocks end-to-end", () => {
    const outlinks = db.getOutlinks("Code Block Test.md");
    expect(outlinks).toHaveLength(1);
    expect(outlinks[0]?.targetRaw).toBe("Note B");
  });

  it("resolves duplicate basenames by shortest-path then alphabetical tie-break", () => {
    const outlinks = db.getOutlinks("Ambiguous Resolution Test.md");
    expect(outlinks[0]?.targetPath).toBe("Folder1/Same Name.md");
  });

  it("resolves a folder-qualified duplicate basename exactly", () => {
    const outlinks = db.getOutlinks("Qualified Resolution Test.md");
    expect(outlinks[0]?.targetPath).toBe("Folder2/Same Name.md");
  });

  it("computes backlinks for a hub note", () => {
    const backlinks = db.getBacklinks("Hub Note.md");
    const sources = backlinks.map((b) => b.sourcePath).sort();
    expect(sources).toEqual([
      "Backlink Test A.md",
      "Backlink Test B.md",
      "Backlink Test C.md",
      "Home.md",
    ]);
  });

  it("finds orphan notes", () => {
    const orphans = db.findOrphans();
    expect(orphans.some((o) => o.path === "Orphan Note.md")).toBe(true);
  });

  it("collects nested tag hierarchies including frontmatter tags", () => {
    const tagCounts = new Map(db.getAllTagCounts().map((t) => [t.tag, t.count]));
    expect(tagCounts.get("project")).toBeGreaterThanOrEqual(1);
    expect(tagCounts.has("project/sub/child")).toBe(true);
    expect(tagCounts.has("priority/high/urgent")).toBe(true);
  });

  it("resolves frontmatter-embedded wikilinks", () => {
    const outlinks = db.getOutlinks("Frontmatter Wikilink Test.md");
    expect(outlinks.find((l) => l.targetRaw === "Note B")?.targetPath).toBe("Note B.md");
  });

  it("handles Korean filenames, tags, aliases and wikilinks", () => {
    const note = db.getFileByPath("한글 노트.md");
    expect(note).toBeDefined();
    const outlinks = db.getOutlinks("한글 노트.md");
    expect(outlinks.find((l) => l.targetRaw === "다른 한글 노트")?.targetPath).toBe("다른 한글 노트.md");

    const aliasOutlinks = db.getOutlinks("한글 별칭 참조.md");
    expect(aliasOutlinks.find((l) => l.targetRaw === "별칭")?.targetPath).toBe("한글 별칭 노트.md");

    const tagCounts = new Map(db.getAllTagCounts().map((t) => [t.tag, t.count]));
    expect(tagCounts.has("한글태그")).toBe(true);
  });

  it("full text search finds notes by content", () => {
    const results = db.search("hub");
    expect(results.some((r) => r.path === "Hub Note.md")).toBe(true);
  });
});
