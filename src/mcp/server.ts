import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "../version.js";
import type { VaultEngine } from "../vault-engine.js";
import * as bases from "./base-tools.js";
import * as mutations from "./mutation-tools.js";
import * as obsidianConfig from "./obsidian-config-tools.js";
import * as tools from "./tools.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function guardedWriteResult(engine: VaultEngine, action: () => string) {
  await engine.checkMountNow();
  const blocked = engine.writeBlockReason();
  if (blocked) return { ...textResult(blocked), isError: true };
  return textResult(action());
}

/**
 * z.object(shape) alone still silently strips unknown keys (Zod's default
 * "strip" mode) instead of rejecting them -- a caller that typos a param
 * name (e.g. `paths` instead of `folder`) gets no error, just a tool call
 * that silently ignored the argument and ran with defaults. .strict() turns
 * that into a clear validation error instead. See DECISIONS.md D22.
 */
function strictSchema<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

// Explicit annotations help clients and registries distinguish safe exploration,
// additive writes, destructive edits, and repeatable configuration operations.
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const ADDITIVE_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE_WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const IDEMPOTENT_WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export const SERVER_INSTRUCTIONS =
  "Use vault_overview to orient yourself in an unfamiliar vault and vault_status when availability may have changed. Prefer get_context_bundle for broad topic context and read_note for one specific note or heading. Use list_folder/list_notes for file enumeration, search_notes for full-text search, and regex_search for patterns. Treat note paths as vault-relative. read_note returns structured fields and line pagination; follow pagination.nextOffset for long notes. bulk_replace defaults to dry-run and returns a rollback ID when applied. Before calling any write tool, confirm that the user intends to modify the vault; use read tools without confirmation. Mount-guard blocks writes while a removable/network vault is unavailable or reconciling.";

export interface CreateServerOptions {
  /** Register all mutation/config write tools. Defaults to true — set to false for a read-only deployment. */
  enableWriteTools?: boolean;
}

export function createServer(engine: VaultEngine, options: CreateServerOptions = {}): McpServer {
  const enableWriteTools = options.enableWriteTools ?? true;
  const server = new McpServer(
    { name: "obsidian-everywhere", version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "vault_overview",
    {
      title: "Vault Overview",
      description:
        "Get a high-level picture of the vault: note counts, top tags, hub notes by PageRank, and recently modified notes. Good first call at the start of a conversation.",
      inputSchema: strictSchema({}),
      annotations: READ_ONLY,
    },
    async () => textResult(tools.vaultOverview(engine)),
  );

  server.registerTool(
    "vault_status",
    {
      title: "Vault Status",
      description:
        "Report mount-guard state, index freshness, indexed counts, write availability, and the last full reconciliation.",
      inputSchema: strictSchema({}),
      annotations: READ_ONLY,
    },
    async () => {
      await engine.checkMountNow();
      return textResult(tools.vaultStatus(engine));
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search Notes",
      description:
        "Full-text search over note content and titles, with optional tag/folder filters. Each result includes its outgoing/incoming link counts and tags.",
      inputSchema: strictSchema({
        query: z
          .string()
          .optional()
          .describe("Full-text search query (FTS5 syntax). Omit to just filter by tag/folder."),
        tag: z.string().optional().describe("Filter to notes carrying this tag (nested tags match as a prefix)."),
        folder: z.string().optional().describe("Filter to notes under this vault-relative folder path."),
        limit: z.number().int().positive().max(100).optional().describe("Max results (default 10)."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.searchNotes(engine, args)),
  );

  server.registerTool(
    "list_folder",
    {
      title: "List Folder",
      description: "List the immediate child folders, Markdown notes, and attachments in one vault folder.",
      inputSchema: strictSchema({
        folder: z.string().optional().describe("Vault-relative folder. Omit for the vault root."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.listFolder(engine, args)),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List Notes",
      description:
        "List note paths explicitly, optionally scoped to a folder, with pagination. Use this instead of an empty full-text search when enumerating files. Pass `properties` to project specific frontmatter fields (e.g. status, project) alongside each note without reading every note individually.",
      inputSchema: strictSchema({
        folder: z.string().optional().describe("Vault-relative folder. Omit for the vault root."),
        recursive: z.boolean().optional().describe("Include nested folders (default true)."),
        offset: z.number().int().nonnegative().optional().describe("Zero-based result offset."),
        limit: z.number().int().positive().max(500).optional().describe("Max notes (default 100)."),
        properties: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Frontmatter field names to include per note, e.g. ['status', 'project']. Missing fields are null.",
          ),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.listNotes(engine, args)),
  );

  server.registerTool(
    "regex_search",
    {
      title: "Regex Search",
      description:
        "Search note bodies with a JavaScript regular expression and return matching file, line, and excerpt.",
      inputSchema: strictSchema({
        pattern: z.string().min(1).max(500).describe("JavaScript regular expression pattern."),
        folder: z.string().optional().describe("Optional vault-relative folder scope."),
        flags: z.string().optional().describe("Any of i, m, s, u (default i)."),
        limit: z.number().int().positive().max(500).optional().describe("Max matching lines (default 50)."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.regexSearch(engine, args)),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read Note",
      description:
        "Read a note's full content plus its graph context header (outlinks, backlinks, tags, frontmatter). Optionally read just one heading's section.",
      inputSchema: strictSchema({
        path: z.string().describe("Note path, title, or alias."),
        heading: z.string().optional().describe("Only return the section under this heading."),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Zero-based line offset within the selected content."),
        limit: z.number().int().positive().max(5000).optional().describe("Maximum lines to return (default 500)."),
      }),
      outputSchema: {
        path: z.string().optional(),
        title: z.string().nullable().optional(),
        content: z.string().optional(),
        frontmatter: z.record(z.string(), z.unknown()).optional(),
        outlinks: z
          .array(
            z.object({
              target: z.string(),
              resolvedPath: z.string().nullable(),
              type: z.string(),
              line: z.number().nullable(),
            }),
          )
          .optional(),
        backlinks: z
          .array(
            z.object({
              sourcePath: z.string(),
              type: z.string(),
              line: z.number().nullable(),
              context: z.string().nullable(),
            }),
          )
          .optional(),
        tags: z.array(z.string()).optional(),
        pagination: z
          .object({
            offset: z.number(),
            limit: z.number(),
            returnedLines: z.number(),
            totalLines: z.number(),
            hasMore: z.boolean(),
            nextOffset: z.number().nullable(),
          })
          .optional(),
        heading: z.string().optional(),
        warning: z.string().optional(),
        // Set instead of the fields above when the note couldn't be resolved.
        // (`outputSchema` requires *some* structuredContent on every response,
        // including this one — see `registerTool`'s validation in the SDK.)
        error: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const data = tools.readNoteData(engine, args);
      if ("error" in data) {
        return { content: [{ type: "text" as const, text: data.error }], structuredContent: { error: data.error } };
      }
      return {
        content: [{ type: "text" as const, text: tools.readNote(engine, args) }],
        structuredContent: { ...data },
      };
    },
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Get Backlinks",
      description: "List every note that links to the given note, with the sentence/line each link appears in.",
      inputSchema: strictSchema({ path: z.string().describe("Note path, title, or alias.") }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.getBacklinks(engine, args)),
  );

  server.registerTool(
    "get_neighborhood",
    {
      title: "Get Neighborhood",
      description:
        "Get the n-hop subgraph around a note: an explicit node list and edge list, treating links as undirected for hop counting.",
      inputSchema: strictSchema({
        path: z.string().describe("Note path, title, or alias."),
        hops: z.number().int().positive().max(5).optional().describe("Hop radius (default 2)."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.getNeighborhood(engine, args)),
  );

  server.registerTool(
    "get_context_bundle",
    {
      title: "Get Context Bundle",
      description:
        "The killer feature: given a topic (note path/title/alias, or a search phrase), pack the center note plus its most relevant 1-hop neighbors (prioritized by backlink count, then recency) into a token budget. Prefer this over read_note when you want broad context on a topic rather than just one note.",
      inputSchema: strictSchema({
        topic: z.string().describe("Note path/title/alias, or a search phrase if no exact note matches."),
        tokenBudget: z.number().int().positive().optional().describe("Approximate token budget (default 4000)."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.getContextBundle(engine, args)),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List Tags",
      description: "List the full tag hierarchy (including nested #parent/child tags) with note counts.",
      inputSchema: strictSchema({}),
      annotations: READ_ONLY,
    },
    async () => textResult(tools.listTags(engine)),
  );

  server.registerTool(
    "get_notes_by_tag",
    {
      title: "Get Notes By Tag",
      description: "List every note carrying a given tag.",
      inputSchema: strictSchema({
        tag: z.string().describe("Tag without the leading #, e.g. 'project/alpha'."),
        includeNested: z
          .boolean()
          .optional()
          .describe("Include notes tagged with nested children of this tag (default true)."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.getNotesByTag(engine, args)),
  );

  server.registerTool(
    "find_path",
    {
      title: "Find Path",
      description:
        "Find the shortest connection path between two notes (links treated as undirected), with a one-line summary of each note along the way. Shows how two concepts are actually connected in the vault.",
      inputSchema: strictSchema({
        from: z.string().describe("Starting note path, title, or alias."),
        to: z.string().describe("Destination note path, title, or alias."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(tools.findPath(engine, args)),
  );

  server.registerTool(
    "get_related",
    {
      title: "Get Related",
      description:
        "Recommend similar notes that are NOT directly linked to the given note. Default method 'jaccard' uses shared tags and shared 1-hop neighbors, to surface notes that probably should be linked but aren't yet. Method 'semantic' instead uses embedding similarity (meaning-based, not requiring shared tags/links at all) -- lazily computes/caches embeddings on first use, which may add latency and returns fewer results until the vault is fully embedded.",
      inputSchema: strictSchema({
        path: z.string().describe("Note path, title, or alias."),
        limit: z.number().int().positive().max(50).optional().describe("Max results (default 5)."),
        method: z.enum(["jaccard", "semantic"]).optional().describe("Similarity method (default jaccard)."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(await tools.getRelated(engine, args)),
  );

  server.registerTool(
    "semantic_search",
    {
      title: "Semantic Search",
      description:
        "Meaning-based search via embedding similarity (multilingual-e5-small) -- finds conceptually related notes even when they don't share the query's exact words, unlike search_notes' full-text matching. Lazily computes/caches embeddings on first use (up to 50 notes per call); if the vault isn't fully embedded yet, the response says how many notes remain and results may be incomplete until a later call finishes indexing them.",
      inputSchema: strictSchema({
        query: z.string().min(1).describe("Free-text search query."),
        limit: z.number().int().positive().max(50).optional().describe("Max results (default 10)."),
        folder: z.string().optional().describe("Optional vault-relative folder scope."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(await tools.semanticSearch(engine, args)),
  );

  server.registerTool(
    "find_orphans",
    {
      title: "Find Orphans",
      description: "List notes with no outgoing or incoming links — useful for vault maintenance.",
      inputSchema: strictSchema({}),
      annotations: READ_ONLY,
    },
    async () => textResult(tools.findOrphans(engine)),
  );

  server.registerTool(
    "find_unresolved",
    {
      title: "Find Unresolved Links",
      description:
        "List links that don't resolve to any note in the vault, grouped by target — useful for vault maintenance.",
      inputSchema: strictSchema({}),
      annotations: READ_ONLY,
    },
    async () => textResult(tools.findUnresolved(engine)),
  );

  server.registerTool(
    "get_hotkeys",
    {
      title: "Get Obsidian Hotkeys",
      description:
        "Read persisted Obsidian hotkey bindings and their actual command IDs from .obsidian/hotkeys.json. This includes configured commands, not the app's full runtime command registry.",
      inputSchema: strictSchema({}),
      annotations: READ_ONLY,
    },
    async () => textResult(obsidianConfig.getHotkeys(engine)),
  );

  server.registerTool(
    "get_obsidian_settings",
    {
      title: "Get Obsidian Settings",
      description: "Read the Templates folder and enabled/disabled core plugins from persisted vault settings.",
      inputSchema: strictSchema({}),
      annotations: READ_ONLY,
    },
    async () => textResult(obsidianConfig.getObsidianSettings(engine)),
  );

  server.registerTool(
    "validate_base",
    {
      title: "Validate Obsidian Base",
      description:
        "Statically validate YAML and core structural fields in a .base file or fenced base block. Reports the limit that formula semantics and rendering require a live Obsidian app.",
      inputSchema: strictSchema({
        path: z.string().optional().describe("Vault-relative .base or Markdown path."),
        content: z.string().optional().describe("Base YAML or Markdown containing fenced base blocks; overrides path."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => textResult(bases.validateBase(engine, args)),
  );

  if (enableWriteTools) {
    server.registerTool(
      "create_note",
      {
        title: "Create Note",
        description:
          "Create a new note in the vault. Fails if the note already exists unless overwrite is set. The note is indexed immediately — outlinks/tags in its content become real graph edges right away, visible to the very next tool call.",
        inputSchema: strictSchema({
          path: z
            .string()
            .describe("Vault-relative path for the new note, e.g. 'Projects/New Idea' (`.md` is added automatically)."),
          content: z.string().optional().describe("Note body (markdown, without frontmatter)."),
          frontmatter: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Frontmatter fields (tags, aliases, or any custom field)."),
          overwrite: z.boolean().optional().describe("Replace the note if it already exists (default false)."),
        }),
        annotations: DESTRUCTIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => tools.createNote(engine, args)),
    );

    server.registerTool(
      "apply_template",
      {
        title: "Apply Template",
        description:
          "Create a new note from an existing template note (path, title, or alias), substituting Obsidian's core Templates plugin variables: {{date}}, {{date:FORMAT}}, {{time}}, {{time:FORMAT}}, {{title}}. FORMAT supports YYYY/YY/MM/DD/HH/mm/ss tokens. Templater-only syntax (<% %>) is not evaluated and is left as literal text. Fails if the target note already exists unless overwrite is set.",
        inputSchema: strictSchema({
          template: z.string().describe("Template note's path, title, or alias."),
          path: z
            .string()
            .describe("Vault-relative path for the new note, e.g. 'Daily/2026-01-01' (`.md` is added automatically)."),
          frontmatter: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Extra frontmatter fields to merge in on top of the rendered template's own frontmatter."),
          overwrite: z.boolean().optional().describe("Replace the note if it already exists (default false)."),
        }),
        annotations: DESTRUCTIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => tools.applyTemplate(engine, args)),
    );

    server.registerTool(
      "append_to_note",
      {
        title: "Append To Note",
        description:
          "Append content to an existing note — either at the end of the file, or at the end of a specific heading's section. Fails without writing anything if the heading isn't found. Reindexed immediately.",
        inputSchema: strictSchema({
          path: z.string().describe("Note path, title, or alias — must already exist."),
          content: z.string().describe("Markdown content to append."),
          heading: z
            .string()
            .optional()
            .describe("Append at the end of this heading's section instead of the end of the file."),
        }),
        annotations: ADDITIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => tools.appendToNote(engine, args)),
    );

    server.registerTool(
      "move_note",
      {
        title: "Move Note",
        description:
          "Move a note to a new vault-relative path and update every resolvable wikilink/Markdown link that pointed to it. Fails if the destination exists.",
        inputSchema: strictSchema({
          from: z.string().describe("Existing note path, title, or alias."),
          to: z.string().describe("New vault-relative path; .md is added automatically."),
          updateLinks: z.boolean().optional().describe("Rewrite inbound links (default true)."),
        }),
        annotations: DESTRUCTIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.moveNote(engine, args)),
    );

    server.registerTool(
      "rename_note",
      {
        title: "Rename Note",
        description: "Rename a note within its current folder and update links that point to it.",
        inputSchema: strictSchema({
          path: z.string().describe("Existing note path, title, or alias."),
          newName: z.string().describe("New filename only; use move_note to change folders."),
          updateLinks: z.boolean().optional().describe("Rewrite inbound links (default true)."),
        }),
        annotations: DESTRUCTIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.renameNote(engine, args)),
    );

    server.registerTool(
      "delete_note",
      {
        title: "Delete Note",
        description:
          "Delete a note. By default it is moved to the vault's .trash folder and deletion is refused when backlinks exist. Permanent deletion and backlink override must be explicit.",
        inputSchema: strictSchema({
          path: z.string().describe("Existing note path, title, or alias."),
          force: z.boolean().optional().describe("Allow deletion when backlinks exist (default false)."),
          permanent: z.boolean().optional().describe("Unlink permanently instead of moving to .trash (default false)."),
        }),
        annotations: DESTRUCTIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.deleteNote(engine, args)),
    );

    server.registerTool(
      "replace_text",
      {
        title: "Replace Text",
        description:
          "Replace exact text in one note without overwriting the full note. Multiple matches require all: true or an exact expectedOccurrences guard.",
        inputSchema: strictSchema({
          path: z.string().describe("Existing note path, title, or alias."),
          find: z.string().min(1).describe("Exact text to find."),
          replace: z.string().describe("Replacement text; may be empty."),
          all: z.boolean().optional().describe("Replace every match (default false)."),
          expectedOccurrences: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe("Abort unless this many matches exist."),
        }),
        annotations: DESTRUCTIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.replaceText(engine, args)),
    );

    server.registerTool(
      "patch_section",
      {
        title: "Patch Section",
        description: "Replace the content under one heading, preserving the heading and the rest of the note.",
        inputSchema: strictSchema({
          path: z.string().describe("Existing note path, title, or alias."),
          heading: z.string().min(1).describe("Heading text, without # markers."),
          content: z.string().describe("New Markdown section content."),
        }),
        annotations: IDEMPOTENT_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.patchSection(engine, args)),
    );

    server.registerTool(
      "update_frontmatter",
      {
        title: "Update Frontmatter",
        description: "Merge one or more fields into a note's YAML frontmatter without replacing its body.",
        inputSchema: strictSchema({
          path: z.string().describe("Existing note path, title, or alias."),
          fields: z.record(z.string(), z.unknown()).describe("Fields to add or replace."),
        }),
        annotations: IDEMPOTENT_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.updateFrontmatter(engine, args)),
    );

    server.registerTool(
      "remove_frontmatter_field",
      {
        title: "Remove Frontmatter Field",
        description: "Remove exactly one YAML frontmatter field without replacing the note body.",
        inputSchema: strictSchema({
          path: z.string().describe("Existing note path, title, or alias."),
          field: z.string().min(1).describe("Top-level frontmatter field name."),
        }),
        annotations: IDEMPOTENT_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.removeFrontmatterField(engine, args)),
    );

    server.registerTool(
      "bulk_update_frontmatter",
      {
        title: "Bulk Update Frontmatter",
        description:
          "Merge the same frontmatter fields into every note under a folder (or the whole vault). Only notes where a value actually changes are touched. Defaults to dry-run, enforces maxFiles, and creates a rollback snapshot (restorable via rollback_bulk_edit) when applied.",
        inputSchema: strictSchema({
          fields: z.record(z.string(), z.unknown()).describe("Fields to add or replace on every matching note."),
          folder: z.string().optional().describe("Optional vault-relative folder scope. Omit for the whole vault."),
          dryRun: z.boolean().optional().describe("Preview only (default true). Set false to apply."),
          maxFiles: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe("Abort above this changed-file count (default 100)."),
        }),
        annotations: DESTRUCTIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.bulkUpdateFrontmatter(engine, args)),
    );

    server.registerTool(
      "bulk_remove_frontmatter_field",
      {
        title: "Bulk Remove Frontmatter Field",
        description:
          "Remove exactly one frontmatter field from every note under a folder (or the whole vault) that carries it. Defaults to dry-run, enforces maxFiles, and creates a rollback snapshot (restorable via rollback_bulk_edit) when applied.",
        inputSchema: strictSchema({
          field: z.string().min(1).describe("Top-level frontmatter field name to remove."),
          folder: z.string().optional().describe("Optional vault-relative folder scope. Omit for the whole vault."),
          dryRun: z.boolean().optional().describe("Preview only (default true). Set false to apply."),
          maxFiles: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe("Abort above this changed-file count (default 100)."),
        }),
        annotations: DESTRUCTIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.bulkRemoveFrontmatterField(engine, args)),
    );

    server.registerTool(
      "add_tags",
      {
        title: "Add Tags",
        description: "Add one or more tags to a note's frontmatter `tags` array, deduplicated against existing tags.",
        inputSchema: strictSchema({
          path: z.string().describe("Existing note path, title, or alias."),
          tags: z.array(z.string().min(1)).min(1).describe("Tags to add, with or without a leading #."),
        }),
        annotations: ADDITIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.addTags(engine, args)),
    );

    server.registerTool(
      "remove_tags",
      {
        title: "Remove Tags",
        description: "Remove one or more tags from a note's frontmatter `tags` array.",
        inputSchema: strictSchema({
          path: z.string().describe("Existing note path, title, or alias."),
          tags: z.array(z.string().min(1)).min(1).describe("Tags to remove, with or without a leading #."),
        }),
        annotations: IDEMPOTENT_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.removeTags(engine, args)),
    );

    server.registerTool(
      "rename_tag",
      {
        title: "Rename Tag",
        description:
          "Rename a tag vault-wide, across both frontmatter `tags` arrays and inline #tag text. Defaults to dry-run and creates a rollback snapshot (restorable via rollback_bulk_edit) when applied.",
        inputSchema: strictSchema({
          from: z.string().min(1).describe("Existing tag name, with or without a leading #."),
          to: z.string().min(1).describe("New tag name, with or without a leading #."),
          includeNested: z
            .boolean()
            .optional()
            .describe("Also rename child tags under from/ (default false), e.g. project/a -> newname/a."),
          dryRun: z.boolean().optional().describe("Preview only (default true). Set false to apply."),
        }),
        annotations: DESTRUCTIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.renameTag(engine, args)),
    );

    server.registerTool(
      "bulk_replace",
      {
        title: "Bulk Replace",
        description:
          "Replace text across notes selected by folder, optionally using regex. Defaults to dry-run, reports every changed file, enforces maxFiles, and creates a rollback snapshot before applying.",
        inputSchema: strictSchema({
          find: z.string().min(1).max(500).describe("Literal text or JavaScript regex pattern."),
          replace: z.string().describe("Replacement text; regex capture references such as $1 are supported."),
          folder: z.string().optional().describe("Optional vault-relative folder scope."),
          regex: z.boolean().optional().describe("Treat find as a regular expression (default false)."),
          caseSensitive: z.boolean().optional().describe("Regex case sensitivity (default true)."),
          dryRun: z.boolean().optional().describe("Preview only (default true). Set false to apply."),
          maxFiles: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe("Abort above this changed-file count (default 100)."),
        }),
        annotations: DESTRUCTIVE_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.bulkReplace(engine, args)),
    );

    server.registerTool(
      "rollback_bulk_edit",
      {
        title: "Rollback Bulk Edit",
        description: "Restore every file from a rollback snapshot created by bulk_replace or rename_tag.",
        inputSchema: strictSchema({ rollbackId: z.string().describe("Rollback ID returned by bulk_replace.") }),
        annotations: IDEMPOTENT_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => mutations.rollbackBulkEdit(engine, args)),
    );

    server.registerTool(
      "set_hotkey",
      {
        title: "Set Obsidian Hotkey",
        description:
          "Set persisted hotkey bindings for an exact Obsidian command ID. The app may need a vault reload; command IDs cannot be runtime-validated by the standalone server.",
        inputSchema: strictSchema({
          commandId: z.string().min(1).describe("Exact command ID, e.g. insert-template."),
          hotkeys: z
            .array(
              z.object({
                modifiers: z.array(z.enum(["Mod", "Ctrl", "Meta", "Shift", "Alt"])),
                key: z.string().min(1),
              }),
            )
            .describe("Bindings; pass an empty array to clear this command's custom hotkeys."),
        }),
        annotations: IDEMPOTENT_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => obsidianConfig.setHotkey(engine, args)),
    );

    server.registerTool(
      "set_templates_folder",
      {
        title: "Set Templates Folder",
        description: "Set the persisted folder used by Obsidian's Templates core plugin.",
        inputSchema: strictSchema({ folder: z.string().min(1).describe("Vault-relative Templates folder path.") }),
        annotations: IDEMPOTENT_WRITE,
      },
      async (args) => guardedWriteResult(engine, () => obsidianConfig.setTemplatesFolder(engine, args)),
    );
  }

  return server;
}

export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
