#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { VaultEngine } from "../dist/vault-engine.js";
import { defaultEmbedder } from "../dist/index/embeddings.js";

const LIMIT_MIB = Number(process.env.OE_MEMORY_LIMIT_MIB ?? 200);
const vaultDir = mkdtempSync(path.join(tmpdir(), "oe-memory-smoke-"));

function simplePdf(text) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length + 31} >>\nstream\nBT /F1 18 Tf 72 720 Td (${text}) Tj ET\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
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

function docx(text) {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from("<Types/>"));
  zip.addFile(
    "word/document.xml",
    Buffer.from(`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
  );
  return zip.toBuffer();
}

function rssMiB() {
  if (global.gc) global.gc();
  return process.memoryUsage().rss / 1024 / 1024;
}

let peak = rssMiB();
function checkpoint(label) {
  const rss = rssMiB();
  peak = Math.max(peak, rss);
  console.log(`${label}: ${rss.toFixed(1)} MiB RSS`);
}

try {
  writeFileSync(path.join(vaultDir, "Home.md"), "![[paper.pdf]] ![[report.docx]] ![[data.txt]]");
  writeFileSync(path.join(vaultDir, "paper.pdf"), simplePdf("Memory smoke PDF"));
  writeFileSync(path.join(vaultDir, "report.docx"), docx("Memory smoke DOCX"));
  writeFileSync(path.join(vaultDir, "data.txt"), "Memory smoke plain text");

  const engine = new VaultEngine({ vaultDir, dbPath: ":memory:" });
  await engine.init();
  checkpoint("idle after vault init");
  await engine.ensureAttachmentExtracted(engine.db.getFileByPath("data.txt").id);
  checkpoint("after text extraction");
  await engine.ensureAttachmentExtracted(engine.db.getFileByPath("report.docx").id);
  checkpoint("after DOCX extraction");
  await engine.ensureAttachmentExtracted(engine.db.getFileByPath("paper.pdf").id);
  checkpoint("after PDF extraction");
  if (process.env.OE_MEMORY_INCLUDE_EMBEDDING === "true") {
    await defaultEmbedder(["Memory smoke semantic text"], "passage");
    checkpoint("after optional semantic embedding");
  }
  await engine.close();
  console.log(`peak: ${peak.toFixed(1)} MiB RSS (limit: ${LIMIT_MIB} MiB)`);
  if (peak > LIMIT_MIB) process.exitCode = 1;
} finally {
  rmSync(vaultDir, { recursive: true, force: true });
}
