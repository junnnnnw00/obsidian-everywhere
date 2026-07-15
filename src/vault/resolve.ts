import { basenameNoExt } from "./paths.js";

export interface ResolvableFile {
  path: string; // vault-relative, posix separators
  isMarkdown: boolean;
  aliases: string[];
}

export interface ResolverIndex {
  byPath: Map<string, ResolvableFile>;
  byBasenameNoExt: Map<string, ResolvableFile[]>;
  byFullBasename: Map<string, ResolvableFile[]>;
  byAlias: Map<string, ResolvableFile[]>;
}

function fullBasename(p: string): string {
  return p.split("/").pop() ?? p;
}

export function buildResolverIndex(files: ResolvableFile[]): ResolverIndex {
  const byPath = new Map<string, ResolvableFile>();
  const byBasenameNoExt = new Map<string, ResolvableFile[]>();
  const byFullBasename = new Map<string, ResolvableFile[]>();
  const byAlias = new Map<string, ResolvableFile[]>();

  const push = (map: Map<string, ResolvableFile[]>, key: string, file: ResolvableFile) => {
    const list = map.get(key);
    if (list) list.push(file);
    else map.set(key, [file]);
  };

  for (const file of files) {
    byPath.set(file.path, file);
    push(byBasenameNoExt, basenameNoExt(file.path), file);
    push(byFullBasename, fullBasename(file.path), file);
    for (const alias of file.aliases) {
      push(byAlias, alias, file);
    }
  }

  return { byPath, byBasenameNoExt, byFullBasename, byAlias };
}

function pickShortest(candidates: ResolvableFile[]): ResolvableFile | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const depthDiff = a.path.split("/").length - b.path.split("/").length;
    if (depthDiff !== 0) return depthDiff;
    return a.path.localeCompare(b.path);
  });
  return sorted[0] ?? null;
}

function normalizeTarget(targetRaw: string): string {
  let t = targetRaw.trim();
  if (t.startsWith("./")) t = t.slice(2);
  t = t.split("\\").join("/");
  return t;
}

/**
 * Obsidian-style link resolution: qualified (contains '/') paths resolve
 * exactly; unqualified names resolve by basename match, preferring the
 * shallowest path and breaking ties alphabetically. Falls back to alias
 * matching. Returns null (unresolved) if nothing matches.
 */
export function resolveLink(targetRaw: string, index: ResolverIndex): ResolvableFile | null {
  const target = normalizeTarget(targetRaw);
  if (!target) return null;

  if (target.includes("/")) {
    const direct = index.byPath.get(target) ?? index.byPath.get(`${target}.md`);
    if (direct) return direct;
    const byFull = index.byFullBasename.get(fullBasename(target));
    return pickShortest(byFull ?? []);
  }

  const hasExt = target.includes(".") && !target.endsWith(".");
  if (hasExt) {
    const exact = index.byFullBasename.get(target);
    if (exact && exact.length > 0) return pickShortest(exact);
  }

  const byBase = index.byBasenameNoExt.get(hasExt ? target.slice(0, target.lastIndexOf(".")) : target);
  if (byBase && byBase.length > 0) return pickShortest(byBase);

  const byAlias = index.byAlias.get(target);
  if (byAlias && byAlias.length > 0) return pickShortest(byAlias);

  return null;
}
