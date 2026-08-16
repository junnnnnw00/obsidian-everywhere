import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_EXTRACTABLE_BYTES, extractAttachment } from "./extract.js";

export function makeZip(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

export function makeSimplePdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${escaped.length + 31} >>\nstream\nBT /F1 18 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe("extractAttachment", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function extract(name: string, content: string | Buffer) {
    const dir = mkdtempSync(path.join(tmpdir(), "oe-attachment-"));
    dirs.push(dir);
    const file = path.join(dir, name);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    writeFileSync(file, data);
    return extractAttachment(file, data.length);
  }

  it("reads UTF-8 text/code/data files, including Korean", async () => {
    const result = await extract("데이터.json", '{"topic":"지식 그래프"}');
    expect(result.status).toBe("extracted");
    expect(result.text).toContain("지식 그래프");
  });

  it("extracts a real PDF page with a page marker", async () => {
    const result = await extract("paper.pdf", makeSimplePdf("Hello PDF vault"));
    expect(result.status).toBe("extracted");
    expect(result.metadata.pages).toBe(1);
    expect(result.text).toContain("## Page 1");
    expect(result.text).toContain("Hello PDF vault");
  });

  it("extracts DOCX paragraphs and tables from actual OOXML", async () => {
    const docx = makeZip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Word document body</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    });
    const result = await extract("report.docx", docx);
    expect(result.status).toBe("extracted");
    expect(result.text).toContain("Word document body");
    expect(result.text).toContain("Cell A");
    expect(result.text).toContain("Cell B");
  });

  it("extracts PPTX text per slide in numeric order", async () => {
    const pptx = makeZip({
      "[Content_Types].xml": "<Types/>",
      "ppt/slides/slide2.xml": '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>',
      "ppt/slides/slide1.xml": '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>',
    });
    const result = await extract("deck.pptx", pptx);
    expect(result.metadata.slides).toBe(2);
    expect(result.text).toMatch(/## Slide 1[\s\S]*First slide[\s\S]*## Slide 2[\s\S]*Second slide/);
  });

  it("extracts XLSX shared strings and sheet names", async () => {
    const xlsx = makeZip({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": '<workbook><sheets><sheet name="Research Data" sheetId="1"/></sheets></workbook>',
      "xl/sharedStrings.xml": "<sst><si><t>Header</t></si><si><t>Graph result</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>',
    });
    const result = await extract("data.xlsx", xlsx);
    expect(result.metadata.sheetNames).toEqual(["Research Data"]);
    expect(result.text).toContain("## Sheet: Research Data");
    expect(result.text).toContain("Header\tGraph result");
  });

  it("marks images without trying to turn their bytes into text", async () => {
    const result = await extract("pixel.png", Buffer.from([137, 80, 78, 71]));
    expect(result.status).toBe("image");
    expect(result.mimeType).toBe("image/png");
    expect(result.text).toBeNull();
  });

  it("reports unknown binary formats and oversized files explicitly", async () => {
    const binary = await extract("archive.bin", Buffer.from([0, 1, 2, 3]));
    expect(binary.status).toBe("unsupported");
    const dir = mkdtempSync(path.join(tmpdir(), "oe-attachment-"));
    dirs.push(dir);
    const oversized = await extractAttachment(path.join(dir, "huge.pdf"), MAX_EXTRACTABLE_BYTES + 1);
    expect(oversized.status).toBe("unsupported");
    expect(oversized.error).toContain("larger");
  });
});
