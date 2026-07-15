import path from "node:path";

export const DEFAULT_EXCLUDE_DIRS = [".obsidian", ".git", "node_modules", ".obsidian-everywhere"];

export function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

export function isMarkdownPath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(".md");
}

export function basenameNoExt(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const idx = base.lastIndexOf(".");
  return idx === -1 ? base : base.slice(0, idx);
}

export function extOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const idx = base.lastIndexOf(".");
  return idx === -1 ? "" : base.slice(idx + 1).toLowerCase();
}

export function shouldExclude(relPath: string, excludeDirs: string[] = DEFAULT_EXCLUDE_DIRS): boolean {
  const segments = relPath.split("/");
  return segments.some((seg) => excludeDirs.includes(seg));
}
