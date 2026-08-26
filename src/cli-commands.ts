import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { normalizeGitRepositoryPath } from "./git/vault-git.js";
import * as mutations from "./mcp/mutation-tools.js";
import * as tools from "./mcp/tools.js";
import { VERSION } from "./version.js";
import { VaultEngine } from "./vault-engine.js";

export type ClientName = "all" | "codex" | "claude-code" | "claude-desktop";

export interface InitOptions {
  vaultDir: string;
  client?: ClientName;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function clientConfig(vaultDir: string): Record<string, unknown> {
  return {
    mcpServers: {
      "obsidian-everywhere": {
        command: "npx",
        args: ["-y", "obsidian-everywhere", vaultDir],
      },
    },
  };
}

/** Generate configuration without touching a user's global client settings. */
export function generateInitOutput(options: InitOptions): string {
  const vaultDir = path.resolve(options.vaultDir);
  const client = options.client ?? "all";
  const sections = ["Obsidian Everywhere setup", `Vault: ${vaultDir}`, ""];
  if (client === "all" || client === "codex") {
    sections.push(
      "Codex CLI / ChatGPT Desktop",
      `  codex mcp add obsidian-everywhere -- npx -y obsidian-everywhere ${shellQuote(vaultDir)}`,
      "",
    );
  }
  if (client === "all" || client === "claude-code") {
    sections.push(
      "Claude Code",
      `  claude mcp add obsidian-everywhere -- npx -y obsidian-everywhere ${shellQuote(vaultDir)}`,
      "",
    );
  }
  if (client === "all" || client === "claude-desktop") {
    sections.push("Claude Desktop (claude_desktop_config.json)", JSON.stringify(clientConfig(vaultDir), null, 2), "");
  }
  sections.push(
    "Verify before connecting:",
    `  npx -y obsidian-everywhere doctor ${shellQuote(vaultDir)}`,
    "",
    "No client configuration files were changed.",
  );
  return sections.join("\n");
}

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface DoctorReport {
  vaultDir: string;
  checks: DoctorCheck[];
  ok: boolean;
  noteCount?: number;
  unresolvedCount?: number;
}

function countMarkdownFiles(directory: string): number {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) count += countMarkdownFiles(absolute);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) count++;
  }
  return count;
}

export async function diagnoseVault(vaultInput: string, gitRepositoryInput = "."): Promise<DoctorReport> {
  const vaultDir = path.resolve(vaultInput);
  const gitRepositoryPath = normalizeGitRepositoryPath(gitRepositoryInput);
  const gitRepositoryParts = gitRepositoryPath === "." ? [] : gitRepositoryPath.split("/");
  const gitRepositoryDir = path.join(vaultDir, ...gitRepositoryParts);
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js",
    status: major >= 20 && major <= 26 ? "pass" : "fail",
    detail: `${process.version} (supported: 20-26)`,
  });

  if (!existsSync(vaultDir) || !statSync(vaultDir).isDirectory()) {
    checks.push({ name: "Vault path", status: "fail", detail: `Directory not found: ${vaultDir}` });
    return { vaultDir, checks, ok: false };
  }
  checks.push({ name: "Vault path", status: "pass", detail: vaultDir });

  try {
    accessSync(vaultDir, constants.R_OK);
    checks.push({ name: "Read access", status: "pass", detail: "Vault is readable" });
  } catch {
    checks.push({ name: "Read access", status: "fail", detail: "Vault is not readable by this process" });
  }
  try {
    accessSync(vaultDir, constants.W_OK);
    checks.push({ name: "Write access", status: "pass", detail: "Write tools can be enabled" });
  } catch {
    checks.push({ name: "Write access", status: "warn", detail: "Read tools work, but write tools will fail" });
  }

  const hasObsidian = existsSync(path.join(vaultDir, ".obsidian"));
  checks.push({
    name: "Obsidian config",
    status: hasObsidian ? "pass" : "warn",
    detail: hasObsidian ? ".obsidian directory found" : "No .obsidian directory; this may be a Markdown folder",
  });

  let gitRepositoryPathIssue: string | null = null;
  let walkedGitPath = vaultDir;
  for (const part of gitRepositoryParts) {
    walkedGitPath = path.join(walkedGitPath, part);
    if (!existsSync(walkedGitPath)) {
      gitRepositoryPathIssue = `Configured Git path '${gitRepositoryPath}' does not exist`;
      break;
    }
    const info = lstatSync(walkedGitPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      gitRepositoryPathIssue = `Configured Git path '${gitRepositoryPath}' must contain only real directories`;
      break;
    }
  }
  const dotGit = path.join(gitRepositoryDir, ".git");
  let gitAvailable = false;
  try {
    const version = execFileSync("git", ["--version"], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      timeout: 5000,
    }).trim();
    gitAvailable = true;
    checks.push({ name: "Git executable", status: "pass", detail: version });
  } catch {
    checks.push({
      name: "Git executable",
      status: existsSync(dotGit) ? "warn" : "pass",
      detail: "Git was not found; it is optional unless you enable the Vault Git tools",
    });
  }

  if (gitRepositoryPathIssue) {
    checks.push({ name: "Git repository", status: "warn", detail: gitRepositoryPathIssue });
  } else if (!existsSync(dotGit)) {
    checks.push({
      name: "Git repository",
      status: "pass",
      detail: `No .git directory at configured path '${gitRepositoryPath}' (Vault Git remains unavailable)`,
    });
  } else if (!lstatSync(dotGit).isDirectory() || lstatSync(dotGit).isSymbolicLink()) {
    checks.push({
      name: "Git repository",
      status: "warn",
      detail: "Linked worktrees, submodule roots, symlinked metadata, and external .git files are not supported",
    });
  } else if (gitAvailable) {
    try {
      const top = execFileSync("git", ["-C", gitRepositoryDir, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        timeout: 5000,
      }).trim();
      const exactRoot = realpathSync.native(top) === realpathSync.native(gitRepositoryDir);
      const remotes = execFileSync("git", ["-C", gitRepositoryDir, "remote"], {
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        timeout: 5000,
      })
        .split(/\r?\n/)
        .filter(Boolean).length;
      checks.push({
        name: "Git repository",
        status: exactRoot ? "pass" : "warn",
        detail: exactRoot
          ? `Configured path '${gitRepositoryPath}' is an exact Git root (${remotes} configured remote(s); URLs hidden)`
          : "Git root does not exactly match the configured repository path; Vault Git will refuse it",
      });
    } catch {
      checks.push({
        name: "Git repository",
        status: "warn",
        detail: ".git exists, but repository identity could not be verified; Vault Git will refuse it",
      });
    }
  }

  let noteCount: number | undefined;
  try {
    noteCount = countMarkdownFiles(vaultDir);
    checks.push({
      name: "Markdown notes",
      status: noteCount > 0 ? "pass" : "warn",
      detail: `${noteCount} note(s) found`,
    });
  } catch (error) {
    checks.push({ name: "Markdown notes", status: "fail", detail: (error as Error).message });
  }

  let unresolvedCount: number | undefined;
  if (!checks.some((check) => check.status === "fail")) {
    const engine = new VaultEngine({ vaultDir, dbPath: ":memory:" });
    try {
      await engine.init();
      unresolvedCount = engine.db.findUnresolved().length;
      checks.push({
        name: "Index engine",
        status: "pass",
        detail: `SQLite, parser, and graph initialized (${unresolvedCount} unresolved link(s))`,
      });
    } catch (error) {
      checks.push({ name: "Index engine", status: "fail", detail: (error as Error).message });
    } finally {
      await engine.close();
    }
  }

  return { vaultDir, checks, ok: !checks.some((check) => check.status === "fail"), noteCount, unresolvedCount };
}

export function formatDoctorReport(report: DoctorReport, options: { redactPaths?: boolean } = {}): string {
  const symbol = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;
  const redact = (detail: string) => (options.redactPaths ? detail.replaceAll(report.vaultDir, "<vault>") : detail);
  return [
    `Obsidian Everywhere doctor v${VERSION}`,
    "",
    ...report.checks.map((check) => `[${symbol[check.status]}] ${check.name}: ${redact(check.detail)}`),
    "",
    report.ok ? "Ready to connect." : "Fix the failed checks, then run doctor again.",
    "This report contains no note content.",
  ].join("\n");
}

function createDemoVault(root: string): void {
  writeFileSync(
    path.join(root, "Home.md"),
    "---\ntags: [dashboard]\n---\n# Home\n\nSee [[Projects/Atlas]] and [[Reading/Graph Notes]].\n",
  );
  writeFileSync(
    path.join(root, "Projects", "Atlas.md"),
    "---\ntags: [project, knowledge-graph]\n---\n# Atlas\n\nConnected to [[Home]] and [[Missing Research]].\n\n> [!todo] Review backlinks\n",
  );
  writeFileSync(
    path.join(root, "Reading", "Graph Notes.md"),
    "---\ntags: [knowledge-graph]\n---\n# Graph Notes\n\nGraph context beats isolated file search. See [[Projects/Atlas]].\n",
  );
}

export async function runDemo(): Promise<string> {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "obsidian-everywhere-demo-"));
  const vaultDir = path.join(tempRoot, "Demo Vault");
  const engine = new VaultEngine({ vaultDir, dbPath: ":memory:" });
  try {
    // Deliberately build the fixture at runtime so the npm package remains a single self-contained executable.
    const projects = path.join(vaultDir, "Projects");
    const reading = path.join(vaultDir, "Reading");
    mkdirSync(projects, { recursive: true });
    mkdirSync(reading, { recursive: true });
    createDemoVault(vaultDir);
    await engine.init();

    const overview = tools.vaultOverview(engine);
    const unresolved = tools.findUnresolved(engine);
    const preview = mutations.bulkReplace(engine, {
      find: "> [!todo] Review backlinks",
      replace: "> [!done] Backlinks reviewed",
      folder: "Projects",
      dryRun: true,
    });
    return [
      "Obsidian Everywhere demo",
      "========================",
      "",
      "$ vault_overview",
      overview,
      "",
      "$ find_unresolved",
      unresolved,
      "",
      "$ bulk_replace (dry-run)",
      preview,
      "",
      "Demo complete. Your files were not used or changed.",
    ].join("\n");
  } finally {
    await engine.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
