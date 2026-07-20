import { readFileSync } from "node:fs";
import matter from "gray-matter";
import path from "node:path";
import { resolveWithinVault, shouldExclude } from "../vault/paths.js";
import type { VaultEngine } from "../vault-engine.js";

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  viewCount: number;
}

function safeBasePath(engine: VaultEngine, requested: string): string {
  const rel = requested.trim().replaceAll("\\", "/");
  if (
    !rel ||
    rel.startsWith("/") ||
    /^[A-Za-z]:/.test(rel) ||
    rel.split("/").some((part) => part === "." || part === "..") ||
    shouldExclude(rel) ||
    !/\.(?:base|md)$/i.test(rel)
  ) {
    throw new Error("path must be a safe, non-excluded vault-relative .base or .md path");
  }
  return resolveWithinVault(engine.vaultDir, rel);
}

function yamlParse(source: string): unknown {
  const grayMatter = matter as typeof matter & { engines: { yaml: { parse: (input: string) => unknown } } };
  return grayMatter.engines.yaml.parse(source);
}

function validateOne(source: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = yamlParse(source);
  } catch (err) {
    return { valid: false, errors: [`YAML parse error: ${(err as Error).message}`], warnings, viewCount: 0 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, errors: ["Base root must be a YAML object."], warnings, viewCount: 0 };
  }
  const base = parsed as Record<string, unknown>;
  if (base.filters !== undefined && (typeof base.filters !== "object" || base.filters === null)) {
    errors.push("filters must be an object or expression tree.");
  }
  if (!Array.isArray(base.views)) {
    errors.push("views must be an array.");
    return { valid: false, errors, warnings, viewCount: 0 };
  }
  for (let index = 0; index < base.views.length; index++) {
    const view = base.views[index];
    if (!view || typeof view !== "object" || Array.isArray(view)) {
      errors.push(`views[${index}] must be an object.`);
      continue;
    }
    const record = view as Record<string, unknown>;
    if (typeof record.type !== "string" || !record.type) errors.push(`views[${index}].type is required.`);
    if (record.name !== undefined && typeof record.name !== "string")
      errors.push(`views[${index}].name must be a string.`);
    if (record.order !== undefined && !Array.isArray(record.order))
      errors.push(`views[${index}].order must be an array.`);
    if (record.groupBy !== undefined && (typeof record.groupBy !== "object" || record.groupBy === null)) {
      errors.push(`views[${index}].groupBy must be an object.`);
    }
  }
  warnings.push(
    "Static validation checks YAML and documented top-level/view shapes. Formula semantics, plugin-defined view types, and actual rendering require a live Obsidian app and cannot be verified by this standalone MCP server.",
  );
  return { valid: errors.length === 0, errors, warnings, viewCount: base.views.length };
}

export function validateBase(engine: VaultEngine, args: { path?: string; content?: string }): string {
  if (!args.path && args.content === undefined) return "Error: provide path or content.";
  let source = args.content;
  try {
    if (source === undefined) source = readFileSync(safeBasePath(engine, args.path!), "utf8");
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  const fenceMatches = [...source.matchAll(/```base\s*\n([\s\S]*?)```/gi)];
  const documents = fenceMatches.length ? fenceMatches.map((match) => match[1] ?? "") : [source];
  const results = documents.map(validateOne);
  return JSON.stringify(
    {
      path: args.path ? path.posix.normalize(args.path.replaceAll("\\", "/")) : null,
      valid: results.every((result) => result.valid),
      documents: results,
    },
    null,
    2,
  );
}
