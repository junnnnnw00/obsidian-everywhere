export type LinkType = "wikilink" | "embed" | "markdown";

export interface ParsedLink {
  type: LinkType;
  targetRaw: string;
  heading?: string;
  blockId?: string;
  alias?: string;
  line: number;
  context: string;
}

export interface ParsedTag {
  tag: string;
  source: "inline" | "frontmatter";
  line?: number;
}

export interface ParsedHeading {
  level: number;
  text: string;
  line: number;
}

export interface ParsedBlock {
  blockId: string;
  line: number;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  links: ParsedLink[];
  tags: ParsedTag[];
  aliases: string[];
  headings: ParsedHeading[];
  blocks: ParsedBlock[];
  title: string | null;
}
