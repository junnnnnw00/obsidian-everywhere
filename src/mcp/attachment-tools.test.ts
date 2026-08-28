import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultEngine } from "../vault-engine.js";
import { createServer } from "./server.js";

function zip(entries: Record<string, string>): Buffer {
  const archive = new AdmZip();
  for (const [name, content] of Object.entries(entries)) archive.addFile(name, Buffer.from(content));
  return archive.toBuffer();
}

function makeSimplePdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length + 31} >>\nstream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

describe("attachment MCP tools", () => {
  let vaultDir: string;
  let engine: VaultEngine;
  let client: Client;

  beforeAll(async () => {
    vaultDir = mkdtempSync(path.join(tmpdir(), "oe-attachment-mcp-"));
    writeFileSync(
      path.join(vaultDir, "Home.md"),
      "Documents: ![[paper.pdf]], ![[deck.pptx]], ![[report.docx]], ![[data.xlsx]], ![[pixel.png]]",
    );
    writeFileSync(path.join(vaultDir, "paper.pdf"), makeSimplePdf("PDF retrieval phrase"));
    writeFileSync(
      path.join(vaultDir, "deck.pptx"),
      zip({
        "[Content_Types].xml": "<Types/>",
        "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Slide one</a:t></a:r></a:p></p:sld>",
        "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Unique presentation retrieval phrase</a:t></a:r></a:p></p:sld>",
      }),
    );
    writeFileSync(path.join(vaultDir, "~$deck.pptx"), Buffer.from("temporary Office owner file"));
    writeFileSync(
      path.join(vaultDir, "report.docx"),
      zip({
        "[Content_Types].xml": "<Types/>",
        "word/document.xml":
          "<w:document><w:body><w:p><w:r><w:t>Word retrieval phrase</w:t></w:r></w:p></w:body></w:document>",
      }),
    );
    writeFileSync(
      path.join(vaultDir, "data.xlsx"),
      zip({
        "[Content_Types].xml": "<Types/>",
        "xl/workbook.xml": '<workbook><sheets><sheet name="Results" sheetId="1"/></sheets></workbook>',
        "xl/sharedStrings.xml": "<sst><si><t>Spreadsheet retrieval phrase</t></si></sst>",
        "xl/worksheets/sheet1.xml":
          '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
      }),
    );
    writeFileSync(path.join(vaultDir, "notes.txt"), "Plain text retrieval phrase");
    writeFileSync(path.join(vaultDir, "pixel.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    writeFileSync(path.join(vaultDir, "unknown.bin"), Buffer.from([0, 1, 2, 3]));

    engine = new VaultEngine({ vaultDir, dbPath: ":memory:" });
    await engine.init();
    const server = createServer(engine, { enableWriteTools: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "attachment-test", version: "1" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await engine.close();
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it("reads a specific PDF page with graph backlinks", async () => {
    const result = (await client.callTool({ name: "read_file", arguments: { path: "paper.pdf", page: 1 } })) as any;
    const text = textOf(result);
    expect(text).toContain("PDF retrieval phrase");
    expect(text).toContain("Referenced by (1)");
    expect(text).toContain("Home.md");
  });

  it("selects PPTX slides and XLSX sheets", async () => {
    const slide = textOf(
      (await client.callTool({ name: "read_file", arguments: { path: "deck.pptx", slide: 2 } })) as any,
    );
    expect(slide).toContain("Unique presentation retrieval phrase");
    expect(slide).not.toContain("Slide one");
    const sheet = textOf(
      (await client.callTool({ name: "read_file", arguments: { path: "data.xlsx", sheet: "Results" } })) as any,
    );
    expect(sheet).toContain("Spreadsheet retrieval phrase");
  });

  it("searches extracted PDF, Office, and text content through persistent FTS", async () => {
    const word = textOf(
      (await client.callTool({ name: "search_files", arguments: { query: "retrieval", limit: 20 } })) as any,
    );
    expect(word).toContain("paper.pdf");
    expect(word).toContain("report.docx");
    expect(word).toContain("deck.pptx");
    expect(word).toContain("data.xlsx");
    expect(word).toContain("notes.txt");
    expect(engine.db.getAttachmentExtraction(engine.db.getFileByPath("paper.pdf")!.id)?.status).toBe("extracted");
  });

  it("applies attachment scope before the FTS limit", async () => {
    const needle = "scopefilterneedle";
    for (let index = 0; index < 75; index++) {
      writeFileSync(
        path.join(vaultDir, `${needle}-${String(index).padStart(2, "0")}.md`),
        `# ${needle}\n\n${needle} ${needle}`,
      );
    }
    writeFileSync(path.join(vaultDir, "z-attachment.txt"), needle);
    engine.refreshNow();
    await engine.ensureAttachmentExtracted(engine.db.getFileByPath("z-attachment.txt")!.id);

    const result = textOf(
      (await client.callTool({
        name: "search_files",
        arguments: { query: needle, extension: "txt", limit: 10 },
      })) as any,
    );
    expect(result).toContain("z-attachment.txt");
  });

  it("finds attachments by filename without treating punctuation as invalid FTS syntax", async () => {
    const result = textOf(
      (await client.callTool({
        name: "search_files",
        arguments: { query: "DECK.PPTX", extension: "pptx", limit: 20 },
      })) as any,
    );
    expect(result).toContain("deck.pptx");
    expect(result).toContain("Match**: filename/path");
    expect(result).not.toContain("fts5:");
  });

  it("skips Office owner files and removes a legacy indexed row on reconciliation", () => {
    expect(engine.db.getFileByPath("~$deck.pptx")).toBeUndefined();
    engine.indexFileNow("~$deck.pptx");
    expect(engine.db.getFileByPath("~$deck.pptx")).toBeDefined();
    engine.refreshNow();
    expect(engine.db.getFileByPath("~$deck.pptx")).toBeUndefined();
  });

  it("recovers an exact attachment path from disk when the watcher has not indexed it yet", async () => {
    writeFileSync(
      path.join(vaultDir, "late-deck.pptx"),
      zip({
        "[Content_Types].xml": "<Types/>",
        "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Late watcher recovery phrase</a:t></a:r></a:p></p:sld>",
      }),
    );

    expect(engine.db.getFileByPath("late-deck.pptx")).toBeUndefined();
    const result = textOf(
      (await client.callTool({ name: "read_file", arguments: { path: "late-deck.pptx", slide: 1 } })) as any,
    );
    expect(result).toContain("Late watcher recovery phrase");
    expect(engine.db.getFileByPath("late-deck.pptx")).toBeDefined();
  });

  it("returns image content as a native MCP image block", async () => {
    const result = (await client.callTool({ name: "read_file", arguments: { path: "pixel.png" } })) as any;
    expect(result.content.some((item: any) => item.type === "image" && item.mimeType === "image/png")).toBe(true);
  });

  it("returns useful metadata instead of crashing on unknown binary formats", async () => {
    const result = (await client.callTool({ name: "read_file", arguments: { path: "unknown.bin" } })) as any;
    expect(textOf(result)).toContain("unsupported");
    expect(textOf(result)).toContain("Binary format has no local text extractor");
  });

  it("invalidates and refreshes extracted text after an attachment changes", async () => {
    writeFileSync(path.join(vaultDir, "notes.txt"), "Changed attachment content");
    engine.indexFileNow("notes.txt");
    const result = (await client.callTool({ name: "read_file", arguments: { path: "notes.txt" } })) as any;
    expect(textOf(result)).toContain("Changed attachment content");
    expect(textOf(result)).not.toContain("Plain text retrieval phrase");
  });
});
