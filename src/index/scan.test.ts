import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VaultDB } from "./db.js";
import { applyFileUpsert, fullScan } from "./scan.js";

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
    expect(sources).toEqual(["Backlink Test A.md", "Backlink Test B.md", "Backlink Test C.md", "Home.md"]);
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

describe("Unicode normalization (NFC/NFD)", () => {
  let tmpVault: string;

  afterEach(() => {
    if (tmpVault) rmSync(tmpVault, { recursive: true, force: true });
  });

  it("indexes an NFD-named file under its NFC path, matching what a JSON client would send", () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-nfd-"));
    const nfcName = "테스트노트.md";
    const nfdName = nfcName.normalize("NFD");
    expect(nfdName).not.toBe(nfcName); // sanity: Korean jamo really do decompose differently
    writeFileSync(path.join(tmpVault, nfdName), "Hello.");

    const db = new VaultDB(":memory:");
    fullScan(db, tmpVault);

    expect(db.getFileByPath(nfcName)).toBeDefined();
    expect(db.getFileByPath(nfdName)).toBeUndefined();
    db.close();
  });

  it("applyFileUpsert also canonicalizes to NFC while still reading the exact on-disk bytes", () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-nfd-"));
    const nfcName = "노트.md";
    const nfdName = nfcName.normalize("NFD");
    writeFileSync(path.join(tmpVault, nfdName), "content");

    const db = new VaultDB(":memory:");
    applyFileUpsert(db, tmpVault, nfdName);

    expect(db.getFileByPath(nfcName)).toBeDefined();
    expect(db.getFileByPath(nfcName)?.raw_content).toBe("content");
    db.close();
  });
});

describe("CJK substring search (trigram fallback)", () => {
  function upsertNote(db: VaultDB, path: string, content: string): void {
    db.upsertFileMeta({
      path,
      isMarkdown: true,
      mtime: 0,
      hash: path,
      title: null,
      frontmatterJson: null,
      rawContent: content,
    });
  }

  it("finds a 3+ character substring inside a Korean compound word unicode61 alone would miss", () => {
    const db = new VaultDB(":memory:");
    upsertNote(db, "Graph Theory.md", "그래프이론 노트입니다.");
    upsertNote(db, "Unrelated.md", "전혀 관련 없는 내용.");

    // unicode61 tokenizes "그래프이론" as one whole-word token; "그래프" is a
    // strict substring of it, not a token match on its own.
    const results = db.search("그래프");
    expect(results.map((r) => r.path)).toContain("Graph Theory.md");
    expect(results.map((r) => r.path)).not.toContain("Unrelated.md");
    db.close();
  });

  it("still returns whole-word unicode61 matches first, unaffected by the trigram fallback", () => {
    const db = new VaultDB(":memory:");
    upsertNote(db, "English.md", "This note is about graph theory.");
    const results = db.search("graph");
    expect(results[0]?.path).toBe("English.md");
    db.close();
  });

  it("does not match a 2-character CJK query (below trigram's 3-char minimum) -- documented limitation", () => {
    const db = new VaultDB(":memory:");
    upsertNote(db, "Korean.md", "한글테스트 노트.");
    expect(db.search("한글")).toHaveLength(0);
    db.close();
  });

  it("backfills the trigram index once for a pre-existing database that predates it", () => {
    const dbFile = path.join(mkdtempSync(path.join(tmpdir(), "oe-trigram-migrate-")), "index.db");
    const db1 = new VaultDB(dbFile);
    upsertNote(db1, "Graph Theory.md", "그래프이론 노트입니다.");
    // Simulate an existing database created before files_fts_trigram existed:
    // wipe just the trigram table, leaving `files`/`files_fts` populated.
    db1.db.exec("DELETE FROM files_fts_trigram");
    db1.close();

    const db2 = new VaultDB(dbFile);
    const results = db2.search("그래프");
    expect(results.map((r) => r.path)).toContain("Graph Theory.md");
    db2.close();
  });
});

describe("VaultDB.transaction", () => {
  it("rolls back every write if the wrapped function throws", () => {
    const db = new VaultDB(":memory:");
    expect(() =>
      db.transaction(() => {
        db.upsertFileMeta({
          path: "Note.md",
          isMarkdown: true,
          mtime: 0,
          hash: "h1",
          title: "Note",
          frontmatterJson: null,
          rawContent: "content",
        });
        throw new Error("simulated mid-transaction failure");
      }),
    ).toThrow("simulated mid-transaction failure");
    expect(db.getFileByPath("Note.md")).toBeUndefined();
    db.close();
  });
});

describe("fullScan atomicity (DECISIONS.md D21)", () => {
  let tmpVault: string;

  afterEach(() => {
    if (tmpVault) {
      // Restore read permission so rmSync can clean up B.md.
      try {
        chmodSync(path.join(tmpVault, "B.md"), 0o644);
      } catch {
        // already restored or never chmod'd
      }
      rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  it("a failure partway through the scan leaves every file's DB state exactly as it was, not partially updated", () => {
    tmpVault = mkdtempSync(path.join(tmpdir(), "oe-scan-atomic-"));
    writeFileSync(path.join(tmpVault, "A.md"), "[[B]]");
    writeFileSync(path.join(tmpVault, "B.md"), "content");

    const db = new VaultDB(":memory:");
    fullScan(db, tmpVault);
    expect(db.getOutlinks("A.md")).toHaveLength(1); // sanity: the first, successful scan worked normally

    // Change A.md (so it needs reprocessing) and make B.md unreadable, so
    // *some* file in this second scan attempt throws -- wherever B.md
    // lands in the walk order, the whole scan (one DB transaction) must
    // roll back, not just skip B.md while keeping A.md's update.
    writeFileSync(path.join(tmpVault, "A.md"), "[[B]] updated");
    chmodSync(path.join(tmpVault, "B.md"), 0o000);

    expect(() => fullScan(db, tmpVault)).toThrow();

    expect(db.getFileByPath("A.md")?.raw_content).toBe("[[B]]"); // NOT "[[B]] updated"
    db.close();
  });
});
