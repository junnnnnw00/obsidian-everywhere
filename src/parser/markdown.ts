import matter from "gray-matter";
import type {
  ParsedBlock,
  ParsedHeading,
  ParsedLink,
  ParsedNote,
  ParsedTag,
} from "./types.js";

const WIKILINK_RE = /(!)?\[\[([^\]]+)\]\]/g;
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const INLINE_CODE_RE = /`[^`]*`/g;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BLOCK_ID_RE = /\s\^([A-Za-z0-9-]+)\s*$/;
const TAG_RE = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
const FENCE_RE = /^(```|~~~)/;

function maskInlineCode(line: string): string {
  return line.replace(INLINE_CODE_RE, (m) => " ".repeat(m.length));
}

function splitWikilinkInner(inner: string): {
  targetRaw: string;
  heading?: string;
  blockId?: string;
  alias?: string;
} {
  const pipeIdx = inner.indexOf("|");
  const left = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
  const alias = pipeIdx === -1 ? undefined : inner.slice(pipeIdx + 1).trim();

  const hashIdx = left.indexOf("#");
  const targetRaw = (hashIdx === -1 ? left : left.slice(0, hashIdx)).trim();
  const rest = hashIdx === -1 ? undefined : left.slice(hashIdx + 1).trim();

  if (!rest) return { targetRaw, alias };
  if (rest.startsWith("^")) {
    return { targetRaw, blockId: rest.slice(1), alias };
  }
  return { targetRaw, heading: rest, alias };
}

function isExternalUrl(target: string): boolean {
  return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(target) || /^mailto:/i.test(target) || target.startsWith("#");
}

function normalizeTagText(raw: string): string | null {
  const tag = raw.replace(/\/+$/, "").trim();
  if (!tag) return null;
  if (/^[0-9_/-]+$/.test(tag)) return null; // must contain at least one letter
  return tag;
}

/** Extract [[wikilink]] targets embedded in arbitrary frontmatter values. */
function extractFrontmatterLinks(data: Record<string, unknown>): ParsedLink[] {
  const links: ParsedLink[] = [];

  function visit(value: unknown): void {
    if (typeof value === "string") {
      let match: RegExpExecArray | null;
      const re = new RegExp(WIKILINK_RE.source, "g");
      while ((match = re.exec(value)) !== null) {
        const isEmbed = match[1] === "!";
        const parsed = splitWikilinkInner(match[2] ?? "");
        if (!parsed.targetRaw) continue;
        links.push({
          type: isEmbed ? "embed" : "wikilink",
          targetRaw: parsed.targetRaw,
          heading: parsed.heading,
          blockId: parsed.blockId,
          alias: parsed.alias,
          line: 0,
          context: value.trim(),
        });
      }
    } else if (Array.isArray(value)) {
      for (const v of value) visit(v);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value)) visit(v);
    }
  }

  visit(data);
  return links;
}

function toStringArray(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => toStringArray(v));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim().replace(/^#/, ""))
      .filter((s) => s.length > 0);
  }
  return [String(value)];
}

export function parseNote(raw: string): ParsedNote {
  const { data, content } = matter(raw);
  const frontmatter = (data ?? {}) as Record<string, unknown>;

  const aliases = toStringArray(frontmatter.aliases ?? frontmatter.alias);
  const frontmatterTags = toStringArray(frontmatter.tags ?? frontmatter.tag);

  const tags: ParsedTag[] = frontmatterTags.map((tag) => ({
    tag,
    source: "frontmatter" as const,
  }));

  const links: ParsedLink[] = extractFrontmatterLinks(frontmatter);
  const headings: ParsedHeading[] = [];
  const blocks: ParsedBlock[] = [];

  const lines = content.split(/\r\n|\n/);
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i] ?? "";

    if (FENCE_RE.test(rawLine.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headingMatch = HEADING_RE.exec(rawLine);
    if (headingMatch) {
      headings.push({
        level: (headingMatch[1] ?? "").length,
        text: (headingMatch[2] ?? "").trim(),
        line: lineNo,
      });
    }

    const blockMatch = BLOCK_ID_RE.exec(rawLine);
    if (blockMatch && blockMatch[1]) {
      blocks.push({ blockId: blockMatch[1], line: lineNo });
    }

    const masked = maskInlineCode(rawLine);
    const trimmedContext = rawLine.trim();

    let wlMatch: RegExpExecArray | null;
    const wlRe = new RegExp(WIKILINK_RE.source, "g");
    while ((wlMatch = wlRe.exec(masked)) !== null) {
      const isEmbed = wlMatch[1] === "!";
      const parsed = splitWikilinkInner(wlMatch[2] ?? "");
      if (!parsed.targetRaw) continue;
      links.push({
        type: isEmbed ? "embed" : "wikilink",
        targetRaw: parsed.targetRaw,
        heading: parsed.heading,
        blockId: parsed.blockId,
        alias: parsed.alias,
        line: lineNo,
        context: trimmedContext,
      });
    }

    let mdMatch: RegExpExecArray | null;
    const mdRe = new RegExp(MARKDOWN_LINK_RE.source, "g");
    while ((mdMatch = mdRe.exec(masked)) !== null) {
      const target = decodeURIComponent((mdMatch[2] ?? "").trim());
      if (!target || isExternalUrl(target)) continue;
      links.push({
        type: "markdown",
        targetRaw: target,
        alias: mdMatch[1] || undefined,
        line: lineNo,
        context: trimmedContext,
      });
    }

    let tagMatch: RegExpExecArray | null;
    const tagRe = new RegExp(TAG_RE.source, "gu");
    while ((tagMatch = tagRe.exec(masked)) !== null) {
      const normalized = normalizeTagText(tagMatch[2] ?? "");
      if (!normalized) continue;
      tags.push({ tag: normalized, source: "inline", line: lineNo });
    }
  }

  const h1 = headings.find((h) => h.level === 1);

  return {
    frontmatter,
    body: content,
    links,
    tags,
    aliases,
    headings,
    blocks,
    title: h1?.text ?? null,
  };
}
