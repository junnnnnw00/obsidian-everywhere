import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldExclude } from "../vault/paths.js";

const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
const DEFAULT_DIFF_BYTES = 64 * 1024;
const MAX_DIFF_BYTES = 256 * 1024;
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const MAX_SCANNED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SCANNED_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_SCANNED_BLOBS = 200;
const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
const MAX_PENDING_APPROVALS = 128;
const APPROVAL_TTL_MS = 5 * 60 * 1000;

export type GitMode = "off" | "read" | "commit" | "push";

export interface GitPushTarget {
  remote: string;
  url: string;
}

export interface VaultGitOptions {
  gitBinary?: string;
  /** Vault-relative repository directory. The vault root remains the default. */
  repositoryPath?: string;
  allowedPushTargets?: GitPushTarget[];
  /** Test-only escape hatch for a local bare remote. Production defaults to HTTPS only. */
  allowedPushProtocols?: Array<"https" | "file">;
  approvalTtlMs?: number;
  now?: () => number;
}

export interface GitStatusArgs {
  includeUntracked?: boolean;
  limit?: number;
}

export interface GitDiffArgs {
  mode?: "unstaged" | "staged" | "head";
  paths?: string[];
  contextLines?: number;
  maxBytes?: number;
}

export interface GitLogArgs {
  limit?: number;
  path?: string;
}

export interface GitCommitPreviewArgs {
  message: string;
  paths: string[];
}

export type GitPushPreviewArgs = Record<string, never>;

interface GitChange {
  path: string;
  previousPath?: string;
  index: string;
  worktree: string;
  kind: "ordinary" | "renamed" | "unmerged" | "untracked";
}

interface GitStatusSnapshot {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
  omittedUnsafe: number;
  hasUnmerged: boolean;
}

interface RepositoryIdentity {
  vaultRoot: string;
  gitDir: string;
  commonDir: string;
  boundaryFingerprint: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

type CapturedGitDirectory = { kind: "missing" } | { kind: "invalid" } | { kind: "directory"; identity: FileIdentity };

interface CommitApproval {
  kind: "commit";
  expiresAt: number;
  boundaryFingerprint: string;
  branchRef: string;
  head: string | null;
  message: string;
  paths: string[];
  stagePaths: string[];
  tree: string;
}

interface PushApproval {
  kind: "push";
  expiresAt: number;
  boundaryFingerprint: string;
  branch: string;
  branchRef: string;
  head: string;
  upstreamOid: string;
  upstreamRef: string;
  remoteBranchRef: string;
  remote: string;
  remoteUrl: string;
}

type Approval = CommitApproval | PushApproval;

interface RunOptions {
  input?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowedExitCodes?: number[];
  extraEnv?: NodeJS.ProcessEnv;
  redactions?: string[];
  /** Keep draining but discard bytes beyond maxBytes instead of terminating. */
  allowTruncation?: boolean;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

class GitError extends Error {}

export function normalizeGitRepositoryPath(value: string | undefined): string {
  const raw = value ?? ".";
  if (
    !raw ||
    raw !== raw.trim() ||
    raw.length > 4096 ||
    raw.includes("\\") ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/.test(raw) ||
    hasControlCharacter(raw, false)
  ) {
    throw new GitError("Git repository path must be '.' or a safe forward-slash vault-relative directory path.");
  }
  if (raw === ".") return ".";
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new GitError("Git repository path must not contain empty, '.' or '..' segments.");
  }
  return parts.join("/");
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function fileIdentity(info: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fingerprintFileIdentity(identity: FileIdentity): string {
  return `${identity.dev.toString()}:${identity.ino.toString()}`;
}

function assertNoSymlinks(root: string, label: string, maxEntries: number, rejectHardlinks = false): void {
  if (!existsSync(root)) return;
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new GitError(`${label} must be a real directory inside .git.`);
  }
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      visited += 1;
      if (visited > maxEntries) {
        throw new GitError(`${label} is too large to verify safely; use Git locally for this operation.`);
      }
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new GitError(`${label} must not contain symbolic links.`);
      if (entry.isDirectory()) pending.push(target);
      else if (rejectHardlinks && lstatSync(target).nlink > 1) {
        throw new GitError(`${label} must not contain hard-linked files.`);
      }
    }
  }
}

function assertMetadataFile(dotGit: string, relPath: string): void {
  const target = path.join(dotGit, ...relPath.split("/"));
  if (!existsSync(target)) return;
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isFile() || !isInside(dotGit, realpathSync.native(target))) {
    throw new GitError(`.git/${relPath} must be a regular file inside the repository metadata directory.`);
  }
}

function assertMetadataLayout(dotGit: string): void {
  const objects = path.join(dotGit, "objects");
  const refs = path.join(dotGit, "refs");
  assertNoSymlinks(refs, ".git/refs", 5000, true);
  assertNoSymlinks(path.join(dotGit, "logs"), ".git/logs", 5000, true);
  if (!existsSync(objects) || lstatSync(objects).isSymbolicLink() || !lstatSync(objects).isDirectory()) {
    throw new GitError(".git/objects must be a real directory inside the repository metadata directory.");
  }
  if (!isInside(dotGit, realpathSync.native(objects))) {
    throw new GitError(".git/objects resolves outside the repository metadata directory.");
  }
  // New loose objects are written through one of the immediate 00..ff
  // fan-out directories; info/pack are also command/config boundaries.
  for (const entry of readdirSync(objects, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new GitError(".git/objects must not contain symbolic links.");
  }
  assertNoSymlinks(path.join(objects, "pack"), ".git/objects/pack", 5000);
  for (const relPath of ["HEAD", "config", "index", "packed-refs"]) assertMetadataFile(dotGit, relPath);
}

function escapeDisplay(value: string): string {
  let escaped = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 9) escaped += "\\t";
    else if (code === 13) escaped += "\\r";
    else if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else escaped += char;
  }
  return escaped;
}

function hasControlCharacter(value: string, allowCommitWhitespace: boolean): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 127) return true;
    if (code < 32 && !(allowCommitWhitespace && (code === 9 || code === 10 || code === 13))) return true;
  }
  return false;
}

function shortOid(oid: string | null): string {
  return oid ? oid.slice(0, 12) : "(unborn)";
}

function normalizedMessage(message: string): string {
  const value = message.trim();
  if (!value) throw new GitError("Commit message must not be empty.");
  if (value.length > 4000) throw new GitError("Commit message must be 4,000 characters or fewer.");
  if (value.includes("\0")) throw new GitError("Commit message must not contain NUL bytes.");
  if (hasControlCharacter(value, false)) {
    throw new GitError("Vault Git commit messages must be a single line without control characters.");
  }
  const finding = secretFinding(value);
  if (finding) throw new GitError(`Possible ${finding} detected in the commit message; the value was not displayed.`);
  return value;
}

function pathLooksSensitive(relPath: string): boolean {
  const base = path.posix.basename(relPath).toLowerCase();
  return (
    /^(?:credentials?|secrets?|tokens?)(?:\.|$)/i.test(base) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(base) ||
    /\.(?:pem|key|p8|p12|pfx|keystore)$/i.test(base)
  );
}

function toSafeGitPath(requested: string): string {
  if (requested.length > 4096) throw new GitError("Git path must be 4,096 characters or fewer.");
  if (!requested || requested.trim() !== requested) throw new GitError("Git paths must be non-empty and unpadded.");
  if (requested.includes("\uFFFD")) throw new GitError("Git paths must be valid UTF-8.");
  if (requested.includes("\\")) throw new GitError("Git paths must use forward slashes.");
  if (requested.startsWith("/") || /^[A-Za-z]:/.test(requested)) {
    throw new GitError("Git paths must be relative to the configured repository root.");
  }
  if (requested.startsWith(":")) throw new GitError("Git pathspec magic is not allowed.");
  if (hasControlCharacter(requested, false)) throw new GitError("Git paths must not contain control characters.");
  const segments = requested.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new GitError("Git paths must not contain empty, '.' or '..' segments.");
  }
  if (shouldExclude(requested) || pathLooksSensitive(requested)) {
    throw new GitError(`Git path is hidden, excluded, or sensitive: ${escapeDisplay(requested)}`);
  }
  return requested;
}

function safeRemoteName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new GitError(`Unsafe Git remote name: ${escapeDisplay(value)}`);
  }
  return value;
}

function cleanProcessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.startsWith("GIT_") ||
      key.startsWith("OBSIDIAN_EVERYWHERE_") ||
      key.startsWith("OAUTH_") ||
      key === "SSH_ASKPASS" ||
      key === "GCM_INTERACTIVE" ||
      /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)(?:$|_)/i.test(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
    ...extra,
  };
}

function sanitizeError(value: string, vaultRoot: string, redactions: string[] = []): string {
  const escapedRoot = vaultRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let sanitized = value;
  for (const redaction of redactions.filter(Boolean).sort((a, b) => b.length - a.length)) {
    const escaped = redaction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    sanitized = sanitized.replace(new RegExp(escaped, "g"), "<remote>");
  }
  return escapeDisplay(sanitized)
    .replace(new RegExp(escapedRoot, "g"), "<vault>")
    .replace(/https:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://***:***@")
    .replace(/https:\/\/[^\s/@]+@/gi, "https://***@");
}

function parseStatus(output: string): GitStatusSnapshot {
  const records = output.split("\0");
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let hasUnmergedRecord = false;
  const rawChanges: GitChange[] = [];

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice("# branch.oid ".length);
      head = value === "(initial)" ? null : value;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("1 ")) {
      const match = /^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]*)$/.exec(record);
      if (match) rawChanges.push({ path: match[2]!, index: match[1]![0]!, worktree: match[1]![1]!, kind: "ordinary" });
      continue;
    }
    if (record.startsWith("2 ")) {
      const match = /^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]*)$/.exec(record);
      const previousPath = records[i + 1];
      if (match && previousPath !== undefined) {
        rawChanges.push({
          path: match[2]!,
          previousPath,
          index: match[1]![0]!,
          worktree: match[1]![1]!,
          kind: "renamed",
        });
        i += 1;
      }
      continue;
    }
    if (record.startsWith("u ")) {
      hasUnmergedRecord = true;
      const match = /^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]*)$/.exec(record);
      if (match) rawChanges.push({ path: match[2]!, index: match[1]![0]!, worktree: match[1]![1]!, kind: "unmerged" });
      continue;
    }
    if (record.startsWith("? ")) {
      rawChanges.push({ path: record.slice(2), index: "?", worktree: "?", kind: "untracked" });
    }
  }

  const changes: GitChange[] = [];
  let omittedUnsafe = 0;
  for (const change of rawChanges) {
    try {
      toSafeGitPath(change.path);
      if (change.previousPath) toSafeGitPath(change.previousPath);
      changes.push(change);
    } catch {
      omittedUnsafe += 1;
    }
  }
  return {
    branch,
    head,
    upstream,
    ahead,
    behind,
    changes,
    omittedUnsafe,
    hasUnmerged: hasUnmergedRecord,
  };
}

function statusCode(change: GitChange): string {
  if (change.kind === "untracked") return "??";
  return `${change.index === "." ? " " : change.index}${change.worktree === "." ? " " : change.worktree}`;
}

function secretFinding(content: string): string | null {
  const rules: Array<[string, RegExp]> = [
    ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
    ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ["npm token", /\bnpm_[A-Za-z0-9]{30,}\b/],
    ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ];
  return rules.find(([, pattern]) => pattern.test(content))?.[0] ?? null;
}

export class VaultGit {
  private readonly configuredVaultDir: string;
  private readonly canonicalVaultRoot: string;
  private readonly repositoryPath: string;
  /** Canonical, fixed cwd for every Git subprocess. */
  private readonly vaultDir: string;
  private readonly vaultRootIdentity: FileIdentity;
  private readonly repositoryRootIdentity: FileIdentity;
  private readonly capturedGitDirectory: CapturedGitDirectory;
  private readonly boundaryFingerprint: string;
  private readonly gitBinary: string;
  private readonly allowedPushTargets = new Map<string, string>();
  private readonly allowedPushProtocols: Set<"https" | "file">;
  private readonly approvalTtlMs: number;
  private readonly now: () => number;
  private readonly disabledHooksPath: string;
  private readonly approvals = new Map<string, Approval>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(vaultDir: string, options: VaultGitOptions = {}) {
    const configuredVault = path.resolve(vaultDir);
    this.configuredVaultDir = configuredVault;
    let canonicalVault: string;
    try {
      canonicalVault = realpathSync.native(configuredVault);
    } catch {
      throw new GitError("The configured vault directory is unavailable.");
    }
    const canonicalVaultInfo = lstatSync(canonicalVault, { bigint: true });
    if (canonicalVaultInfo.isSymbolicLink() || !canonicalVaultInfo.isDirectory()) {
      throw new GitError("The configured vault must resolve to a real directory.");
    }
    this.canonicalVaultRoot = canonicalVault;
    this.vaultRootIdentity = fileIdentity(canonicalVaultInfo);
    this.repositoryPath = normalizeGitRepositoryPath(options.repositoryPath);
    const repositoryParts = this.repositoryPath === "." ? [] : this.repositoryPath.split("/");
    let repositoryDir = canonicalVault;
    for (const part of repositoryParts) {
      repositoryDir = path.join(repositoryDir, part);
      if (!existsSync(repositoryDir)) {
        throw new GitError(
          `Configured Git repository directory '${escapeDisplay(this.repositoryPath)}' does not exist.`,
        );
      }
      const info = lstatSync(repositoryDir, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new GitError("The configured Git repository path must contain only real directories inside the vault.");
      }
    }
    const canonicalRepository = realpathSync.native(repositoryDir);
    if (!isInside(canonicalVault, canonicalRepository)) {
      throw new GitError("The configured Git repository must stay inside the vault.");
    }
    this.vaultDir = canonicalRepository;
    const repositoryInfo = lstatSync(canonicalRepository, { bigint: true });
    if (repositoryInfo.isSymbolicLink() || !repositoryInfo.isDirectory()) {
      throw new GitError("The configured Git repository must resolve to a real directory.");
    }
    this.repositoryRootIdentity = fileIdentity(repositoryInfo);
    const initialDotGit = path.join(canonicalRepository, ".git");
    if (!existsSync(initialDotGit)) {
      this.capturedGitDirectory = { kind: "missing" };
    } else {
      const info = lstatSync(initialDotGit, { bigint: true });
      this.capturedGitDirectory =
        info.isDirectory() && !info.isSymbolicLink()
          ? { kind: "directory", identity: fileIdentity(info) }
          : { kind: "invalid" };
    }
    this.boundaryFingerprint = JSON.stringify({
      vaultRoot: this.canonicalVaultRoot,
      vaultIdentity: fingerprintFileIdentity(this.vaultRootIdentity),
      repositoryRoot: this.vaultDir,
      repositoryIdentity: fingerprintFileIdentity(this.repositoryRootIdentity),
      gitDirectory:
        this.capturedGitDirectory.kind === "directory"
          ? fingerprintFileIdentity(this.capturedGitDirectory.identity)
          : this.capturedGitDirectory.kind,
    });
    this.gitBinary = options.gitBinary ?? "git";
    this.allowedPushProtocols = new Set(options.allowedPushProtocols ?? ["https"]);
    for (const target of options.allowedPushTargets ?? []) {
      const remote = safeRemoteName(target.remote);
      const url = this.validatePushUrl(target.url);
      const existing = this.allowedPushTargets.get(remote);
      if (existing && existing !== url) throw new GitError(`Git push target '${remote}' is configured more than once.`);
      this.allowedPushTargets.set(remote, url);
    }
    this.approvalTtlMs = options.approvalTtlMs ?? APPROVAL_TTL_MS;
    this.now = options.now ?? Date.now;
    this.disabledHooksPath = path.join(os.tmpdir(), `obsidian-everywhere-disabled-hooks-${randomUUID()}`);
  }

  /**
   * Re-establish the operator-selected filesystem boundary immediately before
   * repository inspection and before every subprocess spawn. The cwd remains
   * the canonical path captured at construction; device/inode checks prevent a
   * directory at that same pathname from being silently replaced.
   */
  private assertFixedRepositoryBoundary(): void {
    let currentVaultRoot: string;
    try {
      currentVaultRoot = realpathSync.native(this.configuredVaultDir);
    } catch {
      throw new GitError("The configured vault directory is unavailable; restart after restoring the mount.");
    }
    if (currentVaultRoot !== this.canonicalVaultRoot) {
      throw new GitError("The configured vault identity changed after startup; restart before using Vault Git.");
    }

    let currentVaultInfo;
    try {
      currentVaultInfo = lstatSync(this.canonicalVaultRoot, { bigint: true });
    } catch {
      throw new GitError("The configured vault directory is unavailable; restart after restoring the mount.");
    }
    if (
      currentVaultInfo.isSymbolicLink() ||
      !currentVaultInfo.isDirectory() ||
      !sameFileIdentity(this.vaultRootIdentity, fileIdentity(currentVaultInfo))
    ) {
      throw new GitError("The configured vault identity changed after startup; restart before using Vault Git.");
    }

    let currentRepositoryPath = this.canonicalVaultRoot;
    const repositoryParts = this.repositoryPath === "." ? [] : this.repositoryPath.split("/");
    for (const part of repositoryParts) {
      currentRepositoryPath = path.join(currentRepositoryPath, part);
      let info;
      try {
        info = lstatSync(currentRepositoryPath, { bigint: true });
      } catch {
        throw new GitError("The configured Git repository directory is unavailable; restart after restoring it.");
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new GitError(
          "The configured Git repository path changed or now contains a symbolic link; restart after restoring it.",
        );
      }
    }

    let currentRepositoryRoot: string;
    let currentRepositoryInfo;
    try {
      currentRepositoryRoot = realpathSync.native(currentRepositoryPath);
      currentRepositoryInfo = lstatSync(currentRepositoryRoot, { bigint: true });
    } catch {
      throw new GitError("The configured Git repository directory is unavailable; restart after restoring it.");
    }
    if (
      currentRepositoryRoot !== this.vaultDir ||
      !isInside(this.canonicalVaultRoot, currentRepositoryRoot) ||
      currentRepositoryInfo.isSymbolicLink() ||
      !currentRepositoryInfo.isDirectory() ||
      !sameFileIdentity(this.repositoryRootIdentity, fileIdentity(currentRepositoryInfo))
    ) {
      throw new GitError(
        "The configured Git repository identity changed after startup; restart before using Vault Git.",
      );
    }

    const dotGit = path.join(this.vaultDir, ".git");
    if (this.capturedGitDirectory.kind === "missing") {
      if (existsSync(dotGit)) {
        throw new GitError("The Git metadata directory changed after startup; restart before using Vault Git.");
      }
      return;
    }
    if (!existsSync(dotGit)) {
      throw new GitError("The Git metadata directory changed after startup; restart before using Vault Git.");
    }
    let currentDotGitInfo;
    try {
      currentDotGitInfo = lstatSync(dotGit, { bigint: true });
    } catch {
      throw new GitError("The Git metadata directory is unavailable; restart after restoring it.");
    }
    if (this.capturedGitDirectory.kind === "invalid") {
      if (currentDotGitInfo.isDirectory() && !currentDotGitInfo.isSymbolicLink()) {
        throw new GitError("The Git metadata directory changed after startup; restart before using Vault Git.");
      }
      return;
    }
    if (
      currentDotGitInfo.isSymbolicLink() ||
      !currentDotGitInfo.isDirectory() ||
      !sameFileIdentity(this.capturedGitDirectory.identity, fileIdentity(currentDotGitInfo))
    ) {
      throw new GitError("The Git metadata directory identity changed after startup; restart before using Vault Git.");
    }
  }

  private baseArgs(): string[] {
    return [
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${this.disabledHooksPath}`,
      "-c",
      "core.askPass=",
      "-c",
      "diff.external=",
      "-c",
      "color.ui=false",
      "-c",
      "submodule.recurse=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "push.followTags=false",
      "-c",
      "push.pushOption=",
      "-c",
      "http.followRedirects=false",
      "-c",
      "http.sslVerify=true",
      "-c",
      `safe.directory=${this.vaultDir}`,
    ];
  }

  private run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    this.assertFixedRepositoryBoundary();
    const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? MAX_COMMAND_BYTES;
    const allowedExitCodes = options.allowedExitCodes ?? [0];
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitBinary, [...this.baseArgs(), ...args], {
        cwd: this.vaultDir,
        env: cleanProcessEnv(options.extraEnv),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let stdinError: NodeJS.ErrnoException | null = null;

      const collect = (chunks: Buffer[], chunk: Buffer, isStdout: boolean): void => {
        const used = isStdout ? stdoutBytes : stderrBytes;
        const remaining = Math.max(0, maxBytes - used);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        if (isStdout) stdoutBytes += chunk.length;
        else stderrBytes += chunk.length;
        if (chunk.length > remaining) {
          truncated = true;
          if (!options.allowTruncation) child.kill();
        }
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, true));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, false));
      const handleStdinError = (error: NodeJS.ErrnoException): void => {
        // Fast-exiting Git commands may close their pipe before Node finishes
        // ending stdin. Their exit status remains the authoritative result.
        if (settled || error.code === "EPIPE") return;
        stdinError ??= error;
        child.kill();
      };
      child.stdin.on("error", handleStdinError);

      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error.code === "ENOENT") {
          reject(new GitError("Git executable was not found. Install Git and ensure it is available on PATH."));
        } else {
          reject(new GitError(`Could not start Git: ${error.message}`));
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result: RunResult = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? -1,
          truncated,
        };
        if (timedOut) {
          reject(new GitError(`Git command exceeded the ${timeoutMs} ms safety limit.`));
        } else if (truncated && !options.allowTruncation) {
          reject(new GitError(`Git command exceeded the ${timeoutMs} ms or ${maxBytes} byte safety limit.`));
        } else if (stdinError) {
          const errorCode = stdinError.code ? ` (${stdinError.code})` : "";
          reject(new GitError(`Could not provide Git command input${errorCode}.`));
        } else if (!allowedExitCodes.includes(result.exitCode)) {
          const detail = sanitizeError(
            result.stderr || result.stdout || `exit code ${result.exitCode}`,
            this.vaultDir,
            options.redactions,
          );
          reject(new GitError(`Git command failed: ${detail.trim()}`));
        } else {
          resolve(result);
        }
      });
      try {
        if (options.input === undefined) child.stdin.end();
        else child.stdin.end(options.input);
      } catch (error) {
        handleStdinError(error as NodeJS.ErrnoException);
      }
    });
  }

  private async repositoryIdentity(): Promise<RepositoryIdentity> {
    this.assertFixedRepositoryBoundary();
    const vaultRoot = realpathSync.native(this.vaultDir);
    const dotGit = path.join(vaultRoot, ".git");
    if (!existsSync(dotGit)) {
      throw new GitError("The configured Git repository directory is not a repository (missing .git directory).");
    }
    const dotGitStat = lstatSync(dotGit);
    if (!dotGitStat.isDirectory() || dotGitStat.isSymbolicLink()) {
      throw new GitError("Linked worktrees, submodule roots, and external .git files are not supported by Vault Git.");
    }
    assertMetadataLayout(dotGit);
    const localIncludes = await this.run(
      ["config", "--file", path.join(dotGit, "config"), "--no-includes", "--name-only", "--get-regexp", "^include"],
      { allowedExitCodes: [0, 1] },
    );
    if (localIncludes.exitCode === 0 && localIncludes.stdout.trim()) {
      throw new GitError("Repository-local Git config include/includeIf directives are not supported by Vault Git.");
    }

    const inside = (await this.run(["rev-parse", "--is-inside-work-tree"])).stdout.trim();
    const bare = (await this.run(["rev-parse", "--is-bare-repository"])).stdout.trim();
    const top = realpathSync.native((await this.run(["rev-parse", "--show-toplevel"])).stdout.trim());
    const gitDir = realpathSync.native((await this.run(["rev-parse", "--absolute-git-dir"])).stdout.trim());
    const commonRaw = (await this.run(["rev-parse", "--git-common-dir"])).stdout.trim();
    const commonDir = realpathSync.native(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(vaultRoot, commonRaw));

    if (inside !== "true" || bare === "true" || top !== vaultRoot) {
      throw new GitError("Git repository root must exactly match the configured repository directory.");
    }
    if (!isInside(dotGit, gitDir) || !isInside(dotGit, commonDir)) {
      throw new GitError("Git metadata must remain inside the vault's own .git directory.");
    }
    if (existsSync(path.join(commonDir, "objects", "info", "alternates"))) {
      throw new GitError("Repositories using alternate object stores are not supported by Vault Git.");
    }
    return { vaultRoot, gitDir, commonDir, boundaryFingerprint: this.boundaryFingerprint };
  }

  private async statusSnapshot(includeUntracked = true): Promise<GitStatusSnapshot> {
    await this.repositoryIdentity();
    await this.assertNoTrackedCleanFilters();
    const result = await this.run(
      [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        `--untracked-files=${includeUntracked ? "all" : "no"}`,
        "--ignore-submodules=all",
      ],
      { extraEnv: { GIT_OPTIONAL_LOCKS: "0" } },
    );
    return parseStatus(result.stdout);
  }

  private async assertNoCleanFilters(paths: string[], revealSafePath: boolean): Promise<void> {
    for (let offset = 0; offset < paths.length; offset += 200) {
      const batch = paths.slice(offset, offset + 200);
      const attrs = await this.run(["check-attr", "-z", "--stdin", "filter"], {
        input: `${batch.join("\0")}\0`,
      });
      const parts = attrs.stdout.split("\0");
      for (let i = 0; i + 2 < parts.length; i += 3) {
        const relPath = parts[i]!;
        const value = parts[i + 2]!;
        if (value === "unspecified" || value === "unset") continue;
        if (revealSafePath) {
          try {
            toSafeGitPath(relPath);
            throw new GitError(
              `Git clean filters (including LFS) are not executed by Vault Git: ${escapeDisplay(relPath)}`,
            );
          } catch (error) {
            if (error instanceof GitError && error.message.startsWith("Git clean filters")) throw error;
          }
        }
        throw new GitError(
          "Git clean filters are configured for a tracked path. status/diff/commit are refused because filter commands can execute local programs; use Git locally.",
        );
      }
    }
  }

  private async assertNoTrackedCleanFilters(): Promise<void> {
    const tracked = (await this.run(["ls-files", "-z"])).stdout;
    if (tracked.includes("\uFFFD")) throw new GitError("Repository contains a tracked path that is not valid UTF-8.");
    const paths = tracked.split("\0").filter(Boolean);
    await this.assertNoCleanFilters(paths, false);
  }

  private async branchState(): Promise<{ branch: string; branchRef: string; head: string | null }> {
    const branchRefResult = await this.run(["symbolic-ref", "--quiet", "HEAD"], { allowedExitCodes: [0, 1] });
    const branchRef = branchRefResult.stdout.trim();
    if (!branchRef.startsWith("refs/heads/")) throw new GitError("Git writes require an attached local branch.");
    const headResult = await this.run(["rev-parse", "--verify", "HEAD"], { allowedExitCodes: [0, 128] });
    const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    return { branch: branchRef.slice("refs/heads/".length), branchRef, head };
  }

  private assertNoInProgressOperation(identity: RepositoryIdentity): void {
    const markers = [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "rebase-apply",
      "rebase-merge",
      "sequencer",
    ];
    if (markers.some((marker) => existsSync(path.join(identity.gitDir, marker)))) {
      throw new GitError(
        "Git commit/push is blocked while a merge, rebase, cherry-pick, revert, or bisect is in progress.",
      );
    }
    if (existsSync(path.join(identity.commonDir, "shallow"))) {
      throw new GitError("Shallow repositories are not supported by Vault Git.");
    }
    if (existsSync(path.join(identity.commonDir, "config.worktree"))) {
      throw new GitError("Per-worktree Git configuration is not supported by Vault Git writes.");
    }
    if (
      existsSync(path.join(identity.gitDir, "info", "sparse-checkout")) ||
      existsSync(path.join(identity.commonDir, "info", "sparse-checkout"))
    ) {
      throw new GitError("Sparse checkouts are not supported by Vault Git writes.");
    }
    if (
      existsSync(path.join(identity.commonDir, "info", "grafts")) ||
      existsSync(path.join(identity.commonDir, "refs", "replace"))
    ) {
      throw new GitError("Grafts and replacement refs are not supported by Vault Git writes.");
    }
  }

  private async assertNoUnmergedIndex(): Promise<void> {
    if ((await this.run(["ls-files", "--unmerged", "-z"])).stdout) {
      throw new GitError("Resolve every unmerged index entry locally before using Git commit or push.");
    }
  }

  private async validateSelectedPaths(
    paths: string[],
    status: GitStatusSnapshot,
  ): Promise<{ selected: string[]; stagePaths: string[] }> {
    if (paths.length === 0 || paths.length > 100) throw new GitError("Select between 1 and 100 changed files.");
    const selected = [...new Set(paths.map(toSafeGitPath))].sort();
    if (selected.length !== paths.length) throw new GitError("Duplicate Git paths are not allowed.");
    const changed = new Map(status.changes.map((change) => [change.path, change]));
    for (const relPath of selected) {
      const change = changed.get(relPath);
      if (!change) throw new GitError(`Path is not currently changed: ${escapeDisplay(relPath)}`);
      if (change.kind === "unmerged")
        throw new GitError(`Unmerged path cannot be committed: ${escapeDisplay(relPath)}`);
      const absPath = path.resolve(this.vaultDir, ...relPath.split("/"));
      if (!isInside(path.resolve(this.vaultDir), absPath)) throw new GitError("Git path escapes the vault.");
      if (existsSync(absPath)) {
        const info = lstatSync(absPath);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new GitError(`Only regular files can be committed: ${escapeDisplay(relPath)}`);
        }
      }
      if (change.previousPath) toSafeGitPath(change.previousPath);
    }
    const stagePaths = [
      ...new Set(
        selected.flatMap((relPath) => {
          const previousPath = changed.get(relPath)?.previousPath;
          return previousPath ? [relPath, toSafeGitPath(previousPath)] : [relPath];
        }),
      ),
    ].sort();
    await this.assertNoCleanFilters(stagePaths, true);
    return { selected, stagePaths };
  }

  private async emptyTreeOid(extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    return (await this.run(["hash-object", "-t", "tree", "--stdin"], { input: "", extraEnv })).stdout.trim();
  }

  private async withProposedTree<T>(
    identity: RepositoryIdentity,
    head: string | null,
    stagePaths: string[],
    isolateObjects: boolean,
    action: (tree: string, indexEnv: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    const originalObjects = path.join(identity.commonDir, "objects");
    if (isolateObjects && hasControlCharacter(originalObjects, false)) {
      throw new GitError("Git metadata paths must not contain control characters.");
    }
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "obsidian-everywhere-git-"));
    try {
      const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: path.join(tempRoot, "index") };
      if (isolateObjects) {
        const objects = path.join(tempRoot, "objects");
        const info = path.join(objects, "info");
        mkdirSync(info, { recursive: true });
        // An alternates file avoids the platform-specific path-list parsing of
        // GIT_ALTERNATE_OBJECT_DIRECTORIES (notably Windows drive letters and
        // POSIX paths containing ':'). New preview objects remain isolated.
        writeFileSync(path.join(info, "alternates"), `${originalObjects.replaceAll("\\", "/")}\n`, "utf8");
        indexEnv.GIT_OBJECT_DIRECTORY = objects;
      }
      if (head) await this.run(["read-tree", head], { extraEnv: indexEnv });
      else await this.run(["read-tree", "--empty"], { extraEnv: indexEnv });
      await this.run(["add", "--all", "--", ...stagePaths], {
        timeoutMs: WRITE_TIMEOUT_MS,
        extraEnv: indexEnv,
      });
      const tree = (await this.run(["write-tree"], { extraEnv: indexEnv })).stdout.trim();
      return await action(tree, indexEnv);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  private async reviewProposedTree(
    tree: string,
    selected: string[],
    extraEnv: NodeJS.ProcessEnv,
    scanContent = true,
  ): Promise<void> {
    let total = 0;
    for (const relPath of selected) {
      const entry = (await this.run(["ls-tree", "-z", tree, "--", relPath], { extraEnv })).stdout;
      if (!entry) continue; // The selected path is a deletion.
      const records = entry.split("\0").filter(Boolean);
      if (records.length !== 1)
        throw new GitError(`Selected Git path is not one regular file: ${escapeDisplay(relPath)}`);
      const match = /^(\d+) (\S+) ([0-9a-f]+)\t(.*)$/.exec(records[0]!);
      if (!match || match[4] !== relPath || match[2] !== "blob" || !(match[1] === "100644" || match[1] === "100755")) {
        throw new GitError(`Only regular files can be committed: ${escapeDisplay(relPath)}`);
      }
      if (!scanContent) continue;
      const oid = match[3]!;
      const size = Number((await this.run(["cat-file", "-s", oid], { extraEnv })).stdout.trim());
      if (!Number.isSafeInteger(size) || size > MAX_SCANNED_FILE_BYTES || total + size > MAX_SCANNED_TOTAL_BYTES) {
        throw new GitError(
          `Selected content exceeds the automatic review limit (8 MiB per file, 32 MiB total): ${escapeDisplay(relPath)}. Use Git locally for this commit.`,
        );
      }
      const content = (await this.run(["cat-file", "blob", oid], { maxBytes: size + 1, extraEnv })).stdout;
      total += size;
      if (content.startsWith("version https://git-lfs.github.com/spec/v1")) {
        throw new GitError(`Git LFS content requires local Git: ${escapeDisplay(relPath)}`);
      }
      const finding = secretFinding(content);
      if (finding) {
        throw new GitError(
          `Possible ${finding} detected in ${escapeDisplay(relPath)}. The value was not displayed; commit it manually after review.`,
        );
      }
    }
  }

  private storeApproval(approval: Approval): string {
    for (const [id, stored] of this.approvals) {
      if (stored.expiresAt <= this.now()) this.approvals.delete(id);
    }
    while (this.approvals.size >= MAX_PENDING_APPROVALS) {
      const oldest = this.approvals.keys().next().value as string | undefined;
      if (!oldest) break;
      this.approvals.delete(oldest);
    }
    const id = randomUUID();
    this.approvals.set(id, approval);
    return id;
  }

  private takeApproval<T extends Approval["kind"]>(id: string, kind: T): Extract<Approval, { kind: T }> {
    const approval = this.approvals.get(id);
    this.approvals.delete(id);
    if (!approval || approval.kind !== kind || approval.expiresAt <= this.now()) {
      throw new GitError(`Git ${kind} approval is invalid, expired, or already used. Run the preview again.`);
    }
    return approval as Extract<Approval, { kind: T }>;
  }

  private withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(action, action);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async status(args: GitStatusArgs = {}): Promise<string> {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const status = await this.statusSnapshot(args.includeUntracked ?? true);
    const lines = [
      "# Vault Git Status",
      `Repository: ${escapeDisplay(this.repositoryPath)}`,
      "Git paths: relative to this configured repository",
      `Branch: ${status.branch ? escapeDisplay(status.branch) : "detached"}`,
      `HEAD: ${shortOid(status.head)}`,
      `Upstream: ${status.upstream ? `${escapeDisplay(status.upstream)} (ahead ${status.ahead}, behind ${status.behind}; local tracking state)` : "none"}`,
      `Safe changes: ${status.changes.length}`,
    ];
    if (status.omittedUnsafe) lines.push(`Hidden/excluded/sensitive changes omitted: ${status.omittedUnsafe}`);
    if (status.hasUnmerged) lines.push("Unmerged index entries: present (Git commit/push blocked)");
    if (status.changes.length === 0) lines.push("Working tree is clean within the safe vault path policy.");
    else {
      lines.push("", "## Changes");
      for (const change of status.changes.slice(0, limit)) {
        const rename = change.previousPath ? ` <- ${escapeDisplay(change.previousPath)}` : "";
        lines.push(`- ${statusCode(change)} ${escapeDisplay(change.path)}${rename}`);
      }
      if (status.changes.length > limit)
        lines.push(`- … ${status.changes.length - limit} more safe changes omitted by limit`);
    }
    return lines.join("\n");
  }

  async diff(args: GitDiffArgs = {}): Promise<string> {
    const identity = await this.repositoryIdentity();
    const mode = args.mode ?? "head";
    const contextLines = Math.min(Math.max(args.contextLines ?? 3, 0), 20);
    const maxBytes = Math.min(Math.max(args.maxBytes ?? DEFAULT_DIFF_BYTES, 1024), MAX_DIFF_BYTES);
    const status = await this.statusSnapshot(true);
    let selected: string[];
    let requested: string[] | null = null;
    let includesUntracked = false;
    let omittedPaths = 0;
    if (args.paths?.length) {
      if (args.paths.length > 50) throw new GitError("git_diff accepts at most 50 explicit paths.");
      requested = [...new Set(args.paths.map(toSafeGitPath))].sort();
      if (requested.length !== args.paths.length) throw new GitError("Duplicate Git paths are not allowed.");
      const byPath = new Map(status.changes.map((change) => [change.path, change]));
      selected = [
        ...new Set(
          requested.flatMap((relPath) => {
            const change = byPath.get(relPath);
            if (!change) throw new GitError(`Path is not currently changed: ${escapeDisplay(relPath)}`);
            if (change.kind === "untracked") includesUntracked = true;
            return change.previousPath ? [relPath, change.previousPath] : [relPath];
          }),
        ),
      ].sort();
      if (includesUntracked && mode !== "head") {
        throw new GitError("Untracked files can be reviewed only with git_diff mode=head and an explicit path.");
      }
    } else {
      const candidates = status.changes
        .filter((change) => {
          if (change.kind === "untracked") return false;
          if (mode === "staged") return change.index !== ".";
          if (mode === "unstaged") return change.worktree !== ".";
          return change.index !== "." || change.worktree !== ".";
        })
        .flatMap((change) => (change.previousPath ? [change.path, change.previousPath] : [change.path]));
      selected = [...new Set(candidates.slice(0, 200))].sort();
      omittedPaths = Math.max(0, candidates.length - 200);
    }
    if (selected.length === 0) {
      return `# Vault Git Diff\nRepository: ${escapeDisplay(this.repositoryPath)}\nMode: ${mode}\n\nNo safe changes to diff.`;
    }
    const baseCommand = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--ignore-submodules=all",
      "--no-color",
      `--unified=${contextLines}`,
    ];
    const runDiff = (command: string[], extraEnv: NodeJS.ProcessEnv): Promise<RunResult> =>
      this.run(command, { maxBytes, allowTruncation: true, extraEnv });
    let result: RunResult;
    if (includesUntracked && requested) {
      const { selected: commitPaths, stagePaths } = await this.validateSelectedPaths(requested, status);
      result = await this.withProposedTree(identity, status.head, stagePaths, true, async (tree, indexEnv) => {
        await this.reviewProposedTree(tree, commitPaths, indexEnv, false);
        const base = status.head ?? (await this.emptyTreeOid(indexEnv));
        return runDiff([...baseCommand, "--cached", base, "--", ...selected], indexEnv);
      });
    } else {
      const command = [...baseCommand];
      if (mode === "staged") command.push("--cached", status.head ?? (await this.emptyTreeOid()));
      else if (mode === "head") command.push(status.head ?? (await this.emptyTreeOid()));
      command.push("--", ...selected);
      result = await runDiff(command, { GIT_OPTIONAL_LOCKS: "0" });
    }
    const raw = Buffer.from(result.stdout, "utf8");
    const truncated = result.truncated;
    const patch = escapeDisplay(raw.subarray(0, maxBytes).toString("utf8"));
    return [
      "# Vault Git Diff",
      `Repository: ${escapeDisplay(this.repositoryPath)}`,
      `Mode: ${mode}`,
      `Paths: ${selected.length}`,
      ...(omittedPaths
        ? [`Additional changed paths omitted: ${omittedPaths}; pass explicit paths to inspect them.`]
        : []),
      truncated ? `Output: truncated at ${maxBytes} bytes` : `Output: ${raw.length} bytes`,
      "",
      patch || "(no textual diff; the selected files may be binary or unchanged in this mode)",
      ...(truncated ? ["", "[diff truncated by safety limit]"] : []),
    ].join("\n");
  }

  async log(args: GitLogArgs = {}): Promise<string> {
    await this.repositoryIdentity();
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const command = ["log", `--max-count=${limit}`, "--date=iso-strict", "--pretty=format:%h%x09%aI%x09%an%x09%s"];
    if (args.path) {
      const relPath = toSafeGitPath(args.path);
      const tracked = (await this.run(["ls-files", "-z", "--", relPath])).stdout.split("\0").filter(Boolean);
      if (tracked.length !== 1 || tracked[0] !== relPath) {
        throw new GitError("git_log path must name exactly one currently tracked safe file, not a directory or glob.");
      }
      command.push("--", relPath);
    }
    const result = await this.run(command, { allowedExitCodes: [0, 128], extraEnv: { GIT_OPTIONAL_LOCKS: "0" } });
    if (result.exitCode !== 0 && /does not have any commits yet/i.test(result.stderr)) {
      return `# Vault Git Log\nRepository: ${escapeDisplay(this.repositoryPath)}\n\nNo commits yet.`;
    }
    if (result.exitCode !== 0)
      throw new GitError(`Could not read Git history: ${sanitizeError(result.stderr, this.vaultDir)}`);
    return `# Vault Git Log\nRepository: ${escapeDisplay(this.repositoryPath)}\n\n${escapeDisplay(result.stdout) || "No commits yet."}`;
  }

  async previewCommit(args: GitCommitPreviewArgs): Promise<string> {
    const identity = await this.repositoryIdentity();
    this.assertNoInProgressOperation(identity);
    const message = normalizedMessage(args.message);
    const status = await this.statusSnapshot(true);
    await this.assertNoUnmergedIndex();
    const { selected, stagePaths } = await this.validateSelectedPaths(args.paths, status);
    const branch = await this.branchState();
    const tree = await this.withProposedTree(identity, branch.head, stagePaths, true, async (proposed, indexEnv) => {
      await this.reviewProposedTree(proposed, selected, indexEnv);
      return proposed;
    });
    const approvalId = this.storeApproval({
      kind: "commit",
      expiresAt: this.now() + this.approvalTtlMs,
      boundaryFingerprint: identity.boundaryFingerprint,
      branchRef: branch.branchRef,
      head: branch.head,
      message,
      paths: selected,
      stagePaths,
      tree,
    });
    const lines = [
      "# Vault Git Commit Preview",
      `Repository: ${escapeDisplay(this.repositoryPath)}`,
      `Branch: ${escapeDisplay(branch.branch)}`,
      `HEAD: ${shortOid(branch.head)}`,
      `Message: ${escapeDisplay(message)}`,
      `Proposed tree: ${tree}`,
      `Selected paths: ${selected.length}`,
      ...selected.map((relPath) => {
        const change = status.changes.find((candidate) => candidate.path === relPath)!;
        return `- ${statusCode(change)} ${escapeDisplay(relPath)}`;
      }),
      "",
      "No commit was created. Hooks, signing, hidden paths, clean filters, and suspected secrets are blocked.",
      "Review the exact patch with git_diff(mode=head, paths=[...]) before confirming.",
      `Approval ID (one use, 5 minutes): ${approvalId}`,
      "Call git_commit with action=execute and this approvalId after explicit user confirmation.",
    ];
    return lines.join("\n");
  }

  async commit(approvalId: string): Promise<string> {
    return this.withWriteLock(async () => {
      const approval = this.takeApproval(approvalId, "commit");
      const identity = await this.repositoryIdentity();
      if (identity.boundaryFingerprint !== approval.boundaryFingerprint) {
        throw new GitError("Repository identity changed after preview. No commit was created; preview again.");
      }
      this.assertNoInProgressOperation(identity);
      const branch = await this.branchState();
      const status = await this.statusSnapshot(true);
      await this.assertNoUnmergedIndex();
      const { stagePaths } = await this.validateSelectedPaths(approval.paths, status);
      if (stagePaths.join("\0") !== approval.stagePaths.join("\0")) {
        throw new GitError("Selected rename paths changed after preview. No commit was created; preview again.");
      }
      if (branch.branchRef !== approval.branchRef || branch.head !== approval.head) {
        throw new GitError("Repository state changed after preview. No commit was created; run the preview again.");
      }

      return this.withProposedTree(identity, branch.head, approval.stagePaths, false, async (tree, indexEnv) => {
        await this.reviewProposedTree(tree, approval.paths, indexEnv);
        if (tree !== approval.tree) {
          throw new GitError(
            "Repository state changed after preview: the proposed Git tree now has different content, mode, or attributes. No commit was created; preview again.",
          );
        }
        const commitArgs = ["commit-tree", tree];
        if (branch.head) commitArgs.push("-p", branch.head);
        commitArgs.push("-F", "-");
        const newHead = (
          await this.run(commitArgs, { input: `${approval.message}\n`, extraEnv: indexEnv })
        ).stdout.trim();
        if (branch.head) {
          await this.run(["update-ref", branch.branchRef, newHead, branch.head], { timeoutMs: WRITE_TIMEOUT_MS });
        } else {
          await this.run(["update-ref", "--stdin"], {
            input: `create ${branch.branchRef} ${newHead}\n`,
            timeoutMs: WRITE_TIMEOUT_MS,
          });
        }
        try {
          await this.run(["reset", "-q", newHead, "--", ...approval.stagePaths], { timeoutMs: WRITE_TIMEOUT_MS });
        } catch (error) {
          throw new GitError(
            `Commit ${shortOid(newHead)} was created, but the index could not be refreshed. Inspect git status locally. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return [
          "# Vault Git Commit Created",
          `Repository: ${escapeDisplay(this.repositoryPath)}`,
          `Commit: ${newHead}`,
          `Branch: ${escapeDisplay(branch.branch)}`,
          `Message: ${escapeDisplay(approval.message)}`,
          `Paths: ${approval.paths.length}`,
          "Hooks and signing were not run. The commit has not been pushed.",
        ].join("\n");
      });
    });
  }

  private async pushSnapshot(): Promise<{
    boundaryFingerprint: string;
    branch: string;
    branchRef: string;
    head: string;
    upstreamOid: string;
    upstreamRef: string;
    remoteBranchRef: string;
    remote: string;
    remoteUrl: string;
    ahead: number;
    outgoingSummary: string[];
  }> {
    const identity = await this.repositoryIdentity();
    this.assertNoInProgressOperation(identity);
    await this.assertNoUnmergedIndex();
    const { branch, branchRef, head } = await this.branchState();
    if (!head) throw new GitError("Cannot push an unborn branch. Create the first commit locally or with git_commit.");
    const upstreamLine = (
      await this.run([
        "for-each-ref",
        "--count=1",
        "--format=%(upstream:remotename)%00%(upstream)%00%(upstream:remoteref)",
        branchRef,
      ])
    ).stdout.replace(/\n$/, "");
    const [remoteRaw, upstreamRefRaw, remoteBranchRefRaw] = upstreamLine.split("\0");
    if (!remoteRaw || !upstreamRefRaw || !remoteBranchRefRaw)
      throw new GitError("Current branch has no upstream. Configure it locally before using git_push.");
    const remote = safeRemoteName(remoteRaw);
    const allowedUrl = this.allowedPushTargets.get(remote);
    if (!allowedUrl) {
      throw new GitError(
        `Upstream remote '${escapeDisplay(remote)}' is not in OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES.`,
      );
    }
    if (!upstreamRefRaw.startsWith(`refs/remotes/${remote}/`)) {
      throw new GitError("Current branch must track a normal remote branch before it can be pushed.");
    }
    if (!remoteBranchRefRaw.startsWith("refs/heads/")) {
      throw new GitError("Only an existing upstream branch under refs/heads can be pushed.");
    }
    const upstreamOid = (await this.run(["rev-parse", "--verify", upstreamRefRaw])).stdout.trim();
    const counts = (await this.run(["rev-list", "--left-right", "--count", `${upstreamOid}...${head}`])).stdout.trim();
    const [behindRaw, aheadRaw] = counts.split(/\s+/);
    const behind = Number(behindRaw ?? "0");
    const ahead = Number(aheadRaw ?? "0");
    if (behind > 0)
      throw new GitError(
        `Push is blocked because the local branch is behind its tracking ref by ${behind} commit(s). Fetch and reconcile locally.`,
      );
    const ancestor = await this.run(["merge-base", "--is-ancestor", upstreamOid, head], {
      allowedExitCodes: [0, 1],
    });
    if (ancestor.exitCode !== 0) {
      throw new GitError("The reviewed tracking ref is not an ancestor of HEAD. Reconcile the branch locally.");
    }

    const urls = (await this.run(["remote", "get-url", "--push", "--all", remote])).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    if (urls.length !== 1) throw new GitError("The allowed remote must resolve to exactly one push URL.");
    const remoteUrl = this.validatePushUrl(urls[0]!);
    if (remoteUrl !== allowedUrl) {
      throw new GitError(
        `Remote '${escapeDisplay(remote)}' does not match its exact operator-approved HTTPS destination.`,
      );
    }
    await this.assertNoExecutableLocalPushConfig(remote);
    await this.assertSafeOutgoingHistory(upstreamOid, head);
    const outgoingSummary = (
      await this.run(["log", "--reverse", "--pretty=format:%h%x09%s", `${upstreamOid}..${head}`])
    ).stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(escapeDisplay);
    return {
      boundaryFingerprint: identity.boundaryFingerprint,
      branch,
      branchRef,
      head,
      upstreamOid,
      upstreamRef: upstreamRefRaw,
      remoteBranchRef: remoteBranchRefRaw,
      remote,
      remoteUrl,
      ahead,
      outgoingSummary,
    };
  }

  private validatePushUrl(remoteUrl: string): string {
    if (remoteUrl.trim() !== remoteUrl || !remoteUrl)
      throw new GitError("Push remote URL must be non-empty and unpadded.");
    if (this.allowedPushProtocols.has("file") && path.isAbsolute(remoteUrl)) return path.resolve(remoteUrl);
    let parsed: URL;
    try {
      parsed = new URL(remoteUrl);
    } catch {
      throw new GitError(
        "Push remote must use an HTTPS URL (local paths, SSH, git://, and custom helpers are blocked).",
      );
    }
    if (parsed.protocol === "file:" && this.allowedPushProtocols.has("file")) {
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new GitError("Push remote URL must not embed credentials, query parameters, or fragments.");
      }
      return parsed.href;
    }
    if (parsed.protocol !== "https:" || !this.allowedPushProtocols.has("https")) {
      throw new GitError("Push remote must use HTTPS (SSH, HTTP, file, git://, and custom helpers are blocked).");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new GitError("Push remote URL must not embed credentials, query parameters, or fragments.");
    }
    return parsed.href;
  }

  private async assertNoExecutableLocalPushConfig(remote: string): Promise<void> {
    const result = await this.run(
      [
        "config",
        "--local",
        "--get-regexp",
        "^(credential\\..*\\.helper|credential\\.helper|core\\.sshCommand|url\\..*\\.(insteadOf|pushInsteadOf))$",
      ],
      { allowedExitCodes: [0, 1] },
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      throw new GitError(
        "Repository-local credential helpers, SSH commands, and URL rewrites are not executed by git_push. Move trusted credentials to user-level Git configuration or push locally.",
      );
    }

    // URL-specific http.<url>.* values outrank generic command-line values in
    // Git's URL matching. A repository-local sslVerify=false, redirect policy,
    // curloptResolve, proxy, CA, or extraHeader could therefore reroute a pinned
    // HTTPS push or expose credentials despite baseArgs(). Keep all HTTP
    // transport policy in the operator-trusted system/global scopes instead.
    const localHttp = await this.run(["config", "--local", "--name-only", "--get-regexp", "^http\\."], {
      allowedExitCodes: [0, 1],
    });
    if (localHttp.exitCode === 0 && localHttp.stdout.trim()) {
      throw new GitError(
        "Repository-local http.* configuration is not honored by git_push because it can override pinned HTTPS transport policy. Move trusted HTTP settings to user-level Git configuration or push locally.",
      );
    }

    for (const key of [
      `remote.${remote}.mirror`,
      `remote.${remote}.push`,
      `remote.${remote}.receivepack`,
      `remote.${remote}.proxy`,
      `remote.${remote}.proxyAuthMethod`,
      "push.pushOption",
    ]) {
      const configured = await this.run(["config", "--local", "--get-all", key], { allowedExitCodes: [0, 1] });
      if (configured.exitCode === 0 && configured.stdout.trim()) {
        throw new GitError(
          `Repository-local ${key} is not honored by git_push. Remove it or push locally after reviewing its behavior.`,
        );
      }
    }
  }

  private async assertSafeOutgoingHistory(upstreamOid: string, head: string): Promise<void> {
    const commits = (await this.run(["rev-list", "--max-count=101", `${upstreamOid}..${head}`])).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    if (commits.length > 100) throw new GitError("More than 100 commits are pending; review and push them locally.");
    const seen = new Set<string>();
    let scannedBytes = 0;
    for (const commit of commits) {
      const message = (await this.run(["show", "-s", "--format=%B", commit], { maxBytes: MAX_COMMIT_MESSAGE_BYTES }))
        .stdout;
      const messageFinding = secretFinding(message);
      if (messageFinding) {
        throw new GitError(
          `Possible ${messageFinding} found in an outgoing commit message. The value was not displayed; push manually after review.`,
        );
      }
      const changed = (
        await this.run([
          "diff-tree",
          "--root",
          "-m",
          "--no-commit-id",
          "--name-only",
          "--no-renames",
          "-r",
          "-z",
          commit,
        ])
      ).stdout
        .split("\0")
        .filter(Boolean);
      for (const rawPath of changed) {
        let relPath: string;
        try {
          relPath = toSafeGitPath(rawPath);
        } catch {
          throw new GitError(
            "Outgoing history includes a hidden, excluded, or sensitive path. Its name was not displayed; inspect and push locally.",
          );
        }
        const key = `${commit}:${relPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > MAX_SCANNED_BLOBS) {
          throw new GitError("More than 200 changed blobs are pending; review and push them locally.");
        }
        const entry = (await this.run(["ls-tree", "-z", commit, "--", relPath])).stdout;
        if (!entry) continue; // deleted in this commit
        const records = entry.split("\0").filter(Boolean);
        const match = records.length === 1 ? /^(\d+) (\S+) ([0-9a-f]+)\t(.*)$/.exec(records[0]!) : null;
        if (
          !match ||
          match[4] !== relPath ||
          match[2] !== "blob" ||
          !(match[1] === "100644" || match[1] === "100755")
        ) {
          throw new GitError(`Non-regular Git object in outgoing history: ${escapeDisplay(relPath)}`);
        }
        const oid = match[3]!;
        const size = Number((await this.run(["cat-file", "-s", oid])).stdout.trim());
        if (
          !Number.isSafeInteger(size) ||
          size > MAX_SCANNED_FILE_BYTES ||
          scannedBytes + size > MAX_SCANNED_TOTAL_BYTES
        ) {
          throw new GitError(
            `Outgoing history exceeds the automatic secret-review limit at ${escapeDisplay(relPath)}. Push locally after review.`,
          );
        }
        const blob = (await this.run(["cat-file", "blob", oid], { maxBytes: MAX_SCANNED_FILE_BYTES + 1 })).stdout;
        scannedBytes += Buffer.byteLength(blob);
        if (blob.startsWith("version https://git-lfs.github.com/spec/v1")) {
          throw new GitError(
            `Git LFS content requires its pre-push hook and must be pushed locally: ${escapeDisplay(relPath)}`,
          );
        }
        const finding = secretFinding(blob);
        if (finding)
          throw new GitError(
            `Possible ${finding} found in outgoing history at ${escapeDisplay(relPath)}. The value was not displayed; push manually after review.`,
          );
      }
    }
  }

  async previewPush(_args: GitPushPreviewArgs = {}): Promise<string> {
    const snapshot = await this.pushSnapshot();
    const approvalId = this.storeApproval({
      kind: "push",
      expiresAt: this.now() + this.approvalTtlMs,
      boundaryFingerprint: snapshot.boundaryFingerprint,
      branch: snapshot.branch,
      branchRef: snapshot.branchRef,
      head: snapshot.head,
      upstreamOid: snapshot.upstreamOid,
      upstreamRef: snapshot.upstreamRef,
      remoteBranchRef: snapshot.remoteBranchRef,
      remote: snapshot.remote,
      remoteUrl: snapshot.remoteUrl,
    });
    return [
      "# Vault Git Push Preview",
      `Repository: ${escapeDisplay(this.repositoryPath)}`,
      `Branch: ${escapeDisplay(snapshot.branch)}`,
      `HEAD: ${snapshot.head}`,
      `Upstream branch: ${escapeDisplay(snapshot.remoteBranchRef.slice("refs/heads/".length))}`,
      `Allowed remote: ${escapeDisplay(snapshot.remote)}`,
      `Destination: ${escapeDisplay(snapshot.remoteUrl)}`,
      `Outgoing commits: ${snapshot.ahead}`,
      ...snapshot.outgoingSummary.map((summary) => `- ${summary}`),
      "Network was not contacted and nothing was pushed.",
      "Outgoing merge results, commit messages, paths, and bounded blob content passed the built-in secret/LFS review.",
      `Approval ID (one use, 5 minutes): ${approvalId}`,
      "Call git_push with action=execute and this approvalId after explicit user confirmation.",
    ].join("\n");
  }

  async push(approvalId: string): Promise<string> {
    return this.withWriteLock(async () => {
      const approval = this.takeApproval(approvalId, "push");
      const snapshot = await this.pushSnapshot();
      if (
        snapshot.boundaryFingerprint !== approval.boundaryFingerprint ||
        snapshot.branch !== approval.branch ||
        snapshot.branchRef !== approval.branchRef ||
        snapshot.head !== approval.head ||
        snapshot.upstreamOid !== approval.upstreamOid ||
        snapshot.upstreamRef !== approval.upstreamRef ||
        snapshot.remoteBranchRef !== approval.remoteBranchRef ||
        snapshot.remote !== approval.remote ||
        snapshot.remoteUrl !== approval.remoteUrl
      ) {
        throw new GitError(
          "Repository, upstream, or remote state changed after preview. Nothing was pushed; preview again.",
        );
      }
      const refspec = `${snapshot.head}:${snapshot.remoteBranchRef}`;
      await this.run(
        [
          "push",
          "--porcelain",
          "--no-verify",
          "--no-signed",
          "--no-follow-tags",
          "--recurse-submodules=no",
          `--force-with-lease=${snapshot.remoteBranchRef}:${snapshot.upstreamOid}`,
          snapshot.remoteUrl,
          refspec,
        ],
        {
          timeoutMs: WRITE_TIMEOUT_MS,
          maxBytes: MAX_COMMAND_BYTES,
          redactions: [snapshot.remoteUrl],
        },
      );
      return [
        "# Vault Git Push Complete",
        `Repository: ${escapeDisplay(this.repositoryPath)}`,
        `Branch: ${escapeDisplay(snapshot.branch)}`,
        `Commit: ${snapshot.head}`,
        `Remote: ${escapeDisplay(snapshot.remote)}`,
        "The remote accepted the exact reviewed ref update; the raw Git transcript was omitted.",
        "No unconditional force, tags, submodules, signing, hooks, or unreviewed push options were used.",
      ].join("\n");
    });
  }
}
