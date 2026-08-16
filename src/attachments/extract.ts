import { readFile } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";

export const ATTACHMENT_EXTRACTOR_VERSION = "1";
// These conservative limits are part of the server's low-memory contract.
// Parsers run one file at a time, and no single document can make the process
// retain an unbounded Buffer/string. A normal 8 GB laptop should remain well
// below the 100-200 MB target unless the optional embedding model is invoked.
export const MAX_EXTRACTABLE_BYTES = 32 * 1024 * 1024;
export const MAX_PDF_BYTES = 16 * 1024 * 1024;
export const MAX_ZIP_XML_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 2_000_000;
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

export type ExtractionStatus = "extracted" | "image" | "unsupported" | "error";

export interface AttachmentExtraction {
  status: ExtractionStatus;
  mimeType: string;
  text: string | null;
  metadata: Record<string, unknown>;
  error: string | null;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  epub: "application/epub+zip",
  rtf: "application/rtf",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  java: "text/x-java-source",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  cc: "text/x-c++",
  go: "text/x-go",
  rs: "text/x-rust",
  sh: "text/x-shellscript",
  sql: "application/sql",
  toml: "application/toml",
  ini: "text/plain",
  conf: "text/plain",
  log: "text/plain",
  tex: "application/x-tex",
  bib: "application/x-bibtex",
  eml: "message/rfc822",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  zip: "application/zip",
};

const TEXT_EXTENSIONS = new Set([
  "txt",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "java",
  "c",
  "h",
  "cpp",
  "cc",
  "go",
  "rs",
  "sh",
  "sql",
  "toml",
  "ini",
  "conf",
  "log",
  "tex",
  "bib",
  "eml",
  "svg",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "ico"]);

export function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).slice(1).toLowerCase());
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlText(xml: string, options: { paragraphs?: boolean } = {}): string {
  let value = xml
    .replace(/<w:tab\b[^>]*\/>|<text:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>|<a:br\b[^>]*\/>|<text:line-break\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>|<\/a:p>|<\/text:p>|<\/text:h>/g, options.paragraphs === false ? " " : "\n")
    .replace(/<\/w:tc>|<\/table:table-cell>/g, "\t")
    .replace(/<\/w:tr>|<\/table:table-row>/g, "\n")
    .replace(/<[^>]+>/g, "");
  value = decodeXmlEntities(value)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n");
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function limited(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EXTRACTED_CHARACTERS) return { text, truncated: false };
  return { text: text.slice(0, MAX_EXTRACTED_CHARACTERS), truncated: true };
}

function zipEntryText(zip: AdmZip, name: string): string | null {
  const entry = zip.getEntry(name);
  if (entry && entry.header.size > MAX_ZIP_XML_ENTRY_BYTES) {
    throw new Error(
      `Document XML entry is larger than the ${MAX_ZIP_XML_ENTRY_BYTES / 1024 / 1024} MiB safety limit: ${name}`,
    );
  }
  return entry ? entry.getData().toString("utf8") : null;
}

function extractDocx(buffer: Buffer): { text: string; metadata: Record<string, unknown> } {
  const zip = new AdmZip(buffer);
  const parts = ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"]
    .map((name) => zipEntryText(zip, name))
    .filter((value): value is string => value !== null)
    .map((value) => xmlText(value));
  if (!parts.length) throw new Error("DOCX document.xml is missing");
  return { text: parts.join("\n\n"), metadata: { format: "DOCX" } };
}

function numberedEntries(zip: AdmZip, pattern: RegExp): { number: number; name: string }[] {
  return zip
    .getEntries()
    .map((entry) => ({ match: entry.entryName.match(pattern), name: entry.entryName }))
    .filter((row): row is { match: RegExpMatchArray; name: string } => row.match !== null)
    .map((row) => ({ number: Number(row.match[1]), name: row.name }))
    .sort((a, b) => a.number - b.number);
}

function extractPptx(buffer: Buffer): { text: string; metadata: Record<string, unknown> } {
  const zip = new AdmZip(buffer);
  const slides = numberedEntries(zip, /^ppt\/slides\/slide(\d+)\.xml$/);
  if (!slides.length) throw new Error("PPTX contains no slides");
  const text = slides
    .map(({ number, name }) => `## Slide ${number}\n\n${xmlText(zipEntryText(zip, name) ?? "")}`)
    .join("\n\n");
  return { text, metadata: { format: "PPTX", slides: slides.length } };
}

function extractSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    xmlText(match[1] ?? "", { paragraphs: false }),
  );
}

function columnNumber(cellRef: string): number {
  const letters = cellRef.match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  let result = 0;
  for (const char of letters) result = result * 26 + char.charCodeAt(0) - 64;
  return result;
}

function extractWorksheet(xml: string, sharedStrings: string[]): string {
  const lines: string[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    let currentColumn = 0;
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] ?? "";
      const body = cellMatch[2] ?? "";
      const ref = attrs.match(/\br="([^"]+)"/)?.[1] ?? "A1";
      const targetColumn = columnNumber(ref);
      while (++currentColumn < targetColumn) cells.push("");
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      const value = /\bt="s"/.test(attrs) ? (sharedStrings[Number(raw)] ?? raw) : decodeXmlEntities(raw);
      cells.push(value);
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\n").trim();
}

function extractXlsx(buffer: Buffer): { text: string; metadata: Record<string, unknown> } {
  const zip = new AdmZip(buffer);
  const sheets = numberedEntries(zip, /^xl\/worksheets\/sheet(\d+)\.xml$/);
  if (!sheets.length) throw new Error("XLSX contains no worksheets");
  const shared = extractSharedStrings(zipEntryText(zip, "xl/sharedStrings.xml"));
  const workbook = zipEntryText(zip, "xl/workbook.xml") ?? "";
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map((m) => decodeXmlEntities(m[1] ?? ""));
  const text = sheets
    .map(({ number, name }, index) => {
      const label = names[index] || `Sheet ${number}`;
      return `## Sheet: ${label}\n\n${extractWorksheet(zipEntryText(zip, name) ?? "", shared)}`;
    })
    .join("\n\n");
  return { text, metadata: { format: "XLSX", sheets: sheets.length, sheetNames: names } };
}

function extractOpenDocument(buffer: Buffer, format: string): { text: string; metadata: Record<string, unknown> } {
  const zip = new AdmZip(buffer);
  const content = zipEntryText(zip, "content.xml");
  if (!content) throw new Error(`${format} content.xml is missing`);
  return { text: xmlText(content), metadata: { format } };
}

function extractEpub(buffer: Buffer): { text: string; metadata: Record<string, unknown> } {
  const zip = new AdmZip(buffer);
  const chapters = zip
    .getEntries()
    .filter((entry) => /\.(xhtml|html|htm)$/i.test(entry.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName));
  if (!chapters.length) throw new Error("EPUB contains no HTML chapters");
  const text = chapters
    .map((entry) => `## ${entry.entryName}\n\n${xmlText(entry.getData().toString("utf8"))}`)
    .join("\n\n");
  return { text, metadata: { format: "EPUB", chapters: chapters.length } };
}

function extractRtf(text: string): string {
  return text
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\tab\b/g, "\t")
    .replace(/\\'[0-9a-fA-F]{2}/g, "")
    .replace(/\\u(-?\d+)\??/g, (_, value: string) => String.fromCharCode(Number(value) & 0xffff))
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdf(buffer: Buffer): Promise<{ text: string; metadata: Record<string, unknown> }> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true });
  const document = await loadingTask.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+\n/g, "\n")
        .trim();
      pages.push(`## Page ${pageNumber}\n\n${text}`);
      page.cleanup();
    }
    return { text: pages.join("\n\n"), metadata: { format: "PDF", pages: document.numPages } };
  } finally {
    await document.destroy();
  }
}

function looksLikeUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sample);
  const replacementRatio = decoded.length ? (decoded.match(/�/g)?.length ?? 0) / decoded.length : 0;
  return replacementRatio < 0.01;
}

/** Extract searchable text locally. Never executes macros, scripts, or embedded content. */
export async function extractAttachment(absPath: string, size: number): Promise<AttachmentExtraction> {
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mimeType = mimeTypeForPath(absPath);
  const baseMetadata = { extension: ext || null, size };
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { status: "image", mimeType, text: null, metadata: baseMetadata, error: null };
  }
  if (size > MAX_EXTRACTABLE_BYTES) {
    return {
      status: "unsupported",
      mimeType,
      text: null,
      metadata: baseMetadata,
      error: `File is larger than the ${MAX_EXTRACTABLE_BYTES / 1024 / 1024} MiB extraction limit`,
    };
  }

  try {
    const buffer = await readFile(absPath);
    let result: { text: string; metadata: Record<string, unknown> } | null = null;
    if (ext === "pdf" && size > MAX_PDF_BYTES) {
      return {
        status: "unsupported",
        mimeType,
        text: null,
        metadata: baseMetadata,
        error: `PDF is larger than the ${MAX_PDF_BYTES / 1024 / 1024} MiB low-memory extraction limit`,
      };
    }
    if (ext === "pdf") result = await extractPdf(buffer);
    else if (ext === "docx") result = extractDocx(buffer);
    else if (ext === "pptx") result = extractPptx(buffer);
    else if (ext === "xlsx") result = extractXlsx(buffer);
    else if (["odt", "odp", "ods"].includes(ext)) result = extractOpenDocument(buffer, ext.toUpperCase());
    else if (ext === "epub") result = extractEpub(buffer);
    else if (ext === "rtf") result = { text: extractRtf(buffer.toString("utf8")), metadata: { format: "RTF" } };
    else if (TEXT_EXTENSIONS.has(ext) || looksLikeUtf8Text(buffer)) {
      result = { text: buffer.toString("utf8"), metadata: { format: ext ? ext.toUpperCase() : "TEXT" } };
    }

    if (!result) {
      return {
        status: "unsupported",
        mimeType,
        text: null,
        metadata: baseMetadata,
        error: "Binary format has no local text extractor",
      };
    }
    const capped = limited(result.text.replace(/\u0000/g, ""));
    return {
      status: "extracted",
      mimeType,
      text: capped.text,
      metadata: { ...baseMetadata, ...result.metadata, truncated: capped.truncated },
      error: null,
    };
  } catch (error) {
    return {
      status: "error",
      mimeType,
      text: null,
      metadata: baseMetadata,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
