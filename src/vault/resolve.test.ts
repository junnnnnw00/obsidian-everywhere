import { describe, expect, it } from "vitest";
import { buildResolverIndex, resolveLink, type ResolvableFile } from "./resolve.js";

const files: ResolvableFile[] = [
  { path: "Note A.md", isMarkdown: true, aliases: [] },
  { path: "Note B.md", isMarkdown: true, aliases: [] },
  { path: "Alias Source.md", isMarkdown: true, aliases: ["Alt Name", "AliasSource2"] },
  { path: "Folder1/Same Name.md", isMarkdown: true, aliases: [] },
  { path: "Folder2/Same Name.md", isMarkdown: true, aliases: [] },
  { path: "Attachments/diagram.png", isMarkdown: false, aliases: [] },
];

describe("resolveLink", () => {
  const index = buildResolverIndex(files);

  it("resolves an unqualified basename match", () => {
    expect(resolveLink("Note A", index)?.path).toBe("Note A.md");
  });

  it("resolves via alias", () => {
    expect(resolveLink("Alt Name", index)?.path).toBe("Alias Source.md");
  });

  it("resolves a duplicate basename to the shallowest, alphabetically-first candidate", () => {
    expect(resolveLink("Same Name", index)?.path).toBe("Folder1/Same Name.md");
  });

  it("resolves a folder-qualified link exactly", () => {
    expect(resolveLink("Folder2/Same Name", index)?.path).toBe("Folder2/Same Name.md");
  });

  it("resolves an attachment by filename with extension", () => {
    expect(resolveLink("diagram.png", index)?.path).toBe("Attachments/diagram.png");
  });

  it("returns null for a nonexistent target", () => {
    expect(resolveLink("Does Not Exist", index)).toBeNull();
  });
});
