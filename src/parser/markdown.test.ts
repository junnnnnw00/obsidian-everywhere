import { describe, expect, it } from "vitest";
import { parseNote } from "./markdown.js";

describe("parseNote", () => {
  it("parses a plain wikilink", () => {
    const p = parseNote("See [[Note B]] for more.");
    expect(p.links).toHaveLength(1);
    expect(p.links[0]).toMatchObject({ type: "wikilink", targetRaw: "Note B" });
  });

  it("parses a piped alias wikilink", () => {
    const p = parseNote("See [[Note A|Display Text]].");
    expect(p.links[0]).toMatchObject({
      type: "wikilink",
      targetRaw: "Note A",
      alias: "Display Text",
    });
  });

  it("parses a heading link", () => {
    const p = parseNote("[[Note B#Some Heading]]");
    expect(p.links[0]).toMatchObject({ targetRaw: "Note B", heading: "Some Heading" });
  });

  it("parses a block link", () => {
    const p = parseNote("[[Note C#^blockid]]");
    expect(p.links[0]).toMatchObject({ targetRaw: "Note C", blockId: "blockid" });
  });

  it("parses note and image embeds distinctly from wikilinks", () => {
    const p = parseNote("![[Note A]]\n![[diagram.png]]\n[[Note A]]");
    const types = p.links.map((l) => `${l.type}:${l.targetRaw}`);
    expect(types).toEqual([
      "embed:Note A",
      "embed:diagram.png",
      "wikilink:Note A",
    ]);
  });

  it("parses markdown links but ignores external and anchor links", () => {
    const p = parseNote(
      "[Link to Note B](Note%20B.md)\n[External](https://example.com)\n[Anchor](#heading)",
    );
    expect(p.links).toHaveLength(1);
    expect(p.links[0]).toMatchObject({ type: "markdown", targetRaw: "Note B.md" });
  });

  it("ignores wikilinks inside fenced code blocks", () => {
    const p = parseNote("```\n[[Note A]]\n![[Note A]]\n```\n[[Note B]]");
    expect(p.links).toHaveLength(1);
    expect(p.links[0]?.targetRaw).toBe("Note B");
  });

  it("ignores wikilinks inside inline code", () => {
    const p = parseNote("Inline `[[Note A]]` should be ignored, but [[Note B]] is real.");
    expect(p.links).toHaveLength(1);
    expect(p.links[0]?.targetRaw).toBe("Note B");
  });

  it("parses frontmatter tags, aliases, and arbitrary fields", () => {
    const p = parseNote(
      `---\ntitle: T\ntags: [frontmatter, test]\naliases: ["FM Test"]\nstatus: draft\npriority: 3\n---\nBody`,
    );
    expect(p.frontmatter.status).toBe("draft");
    expect(p.frontmatter.priority).toBe(3);
    expect(p.aliases).toEqual(["FM Test"]);
    expect(p.tags.map((t) => t.tag).sort()).toEqual(["frontmatter", "test"]);
  });

  it("extracts wikilinks embedded in frontmatter field values", () => {
    const p = parseNote(`---\nrelated: "[[Note B]]"\n---\nBody`);
    expect(p.links).toHaveLength(1);
    expect(p.links[0]).toMatchObject({ targetRaw: "Note B" });
  });

  it("parses nested inline tags", () => {
    const p = parseNote("#project #status/active #priority/high/urgent");
    expect(p.tags.map((t) => t.tag)).toEqual([
      "project",
      "status/active",
      "priority/high/urgent",
    ]);
  });

  it("does not treat purely numeric hashes as tags", () => {
    const p = parseNote("Issue #123 is not a tag.");
    expect(p.tags).toHaveLength(0);
  });

  it("extracts headings and block ids", () => {
    const p = parseNote("# Title\n\n## Sub\n\nSome content. ^blockid");
    expect(p.headings).toEqual([
      { level: 1, text: "Title", line: 1 },
      { level: 2, text: "Sub", line: 3 },
    ]);
    expect(p.blocks).toEqual([{ blockId: "blockid", line: 5 }]);
    expect(p.title).toBe("Title");
  });

  it("parses Korean wikilinks and tags", () => {
    const p = parseNote("[[다른 한글 노트]]를 참조합니다. 태그: #한글태그 #프로젝트/하위");
    expect(p.links[0]).toMatchObject({ targetRaw: "다른 한글 노트" });
    expect(p.tags.map((t) => t.tag)).toEqual(["한글태그", "프로젝트/하위"]);
  });
});
