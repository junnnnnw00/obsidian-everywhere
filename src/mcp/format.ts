/** Cheap token estimate (~4 chars/token) used for context-bundle packing decisions. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatFrontmatter(frontmatterJson: string | null): string {
  if (!frontmatterJson) return "";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(frontmatterJson);
  } catch {
    return "";
  }
  const keys = Object.keys(data);
  if (keys.length === 0) return "";
  return keys
    .map((k) => {
      const v = data[k];
      const rendered = typeof v === "string" ? v : JSON.stringify(v);
      return `- **${k}**: ${rendered}`;
    })
    .join("\n");
}

export function firstParagraph(body: string): string {
  const lines = body.split(/\r\n|\n/);
  const paragraph: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (started) break;
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      if (started) break;
      continue;
    }
    started = true;
    paragraph.push(trimmed);
  }
  return paragraph.join(" ");
}

export function extractSection(
  body: string,
  headings: { level: number; text: string; line: number }[],
  targetHeadingText: string,
): string | null {
  const idx = headings.findIndex((h) => h.text.trim().toLowerCase() === targetHeadingText.trim().toLowerCase());
  if (idx === -1) return null;
  const target = headings[idx]!;
  const lines = body.split(/\r\n|\n/);
  let endLine = lines.length + 1;
  for (let i = idx + 1; i < headings.length; i++) {
    if (headings[i]!.level <= target.level) {
      endLine = headings[i]!.line;
      break;
    }
  }
  return lines.slice(target.line - 1, endLine - 1).join("\n").trim();
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n[...truncated]`;
}
