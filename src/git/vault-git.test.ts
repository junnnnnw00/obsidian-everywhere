import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultGit } from "./vault-git.js";

const tempRoots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      LC_ALL: "C",
    },
  }).trim();
}

function createRepository(options: { remote?: boolean } = {}): { root: string; vault: string; remote?: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "oe-vault-git-test-"));
  tempRoots.push(root);
  const vault = path.join(root, "Vault With Spaces");
  mkdirSync(path.join(vault, "Folder"), { recursive: true });
  writeFileSync(path.join(vault, "Alpha.md"), "# Alpha\n\nInitial.\n");
  writeFileSync(path.join(vault, "Unrelated.md"), "# Unrelated\n\nInitial.\n");
  writeFileSync(path.join(vault, "Folder", "한글 노트.md"), "# 한글\n");
  git(root, ["init", "--template=", "--initial-branch=main", vault]);
  mkdirSync(path.join(vault, ".git", "hooks"), { recursive: true });
  git(vault, ["config", "user.name", "OE Test"]);
  git(vault, ["config", "user.email", "oe@example.invalid"]);
  git(vault, ["config", "commit.gpgSign", "false"]);
  git(vault, ["config", "core.autocrlf", "false"]);
  git(vault, ["add", "--", "Alpha.md", "Unrelated.md", "Folder/한글 노트.md"]);
  git(vault, ["commit", "-m", "Initial vault"]);

  if (!options.remote) return { root, vault };
  const remote = path.join(root, "remote.git");
  git(root, ["init", "--bare", "--template=", "--initial-branch=main", remote]);
  git(vault, ["remote", "add", "origin", remote]);
  git(vault, ["push", "-u", "origin", "main"]);
  return { root, vault, remote };
}

function approvalId(text: string): string {
  const match = /Approval ID \(one use, 5 minutes\): ([0-9a-f-]{36})/.exec(text);
  if (!match) throw new Error(`No approval ID in:\n${text}`);
  return match[1]!;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("VaultGit", () => {
  it("reports safe status, bounded diffs, and local history", async () => {
    const { vault } = createRepository();
    writeFileSync(path.join(vault, "Alpha.md"), "# Alpha\n\nChanged.\n");
    writeFileSync(path.join(vault, "Folder", "new note.md"), "# New\n");
    writeFileSync(path.join(vault, ".env"), "SECRET=hidden\n");
    const service = new VaultGit(vault);

    const status = await service.status();
    expect(status).toContain("Branch: main");
    expect(status).toContain(" M Alpha.md");
    expect(status).toContain("?? Folder/new note.md");
    expect(status).toContain("Hidden/excluded/sensitive changes omitted: 1");
    expect(status).not.toContain(".env");

    const diff = await service.diff({ mode: "head", paths: ["Alpha.md"], maxBytes: 4096 });
    expect(diff).toContain("-Initial.");
    expect(diff).toContain("+Changed.");
    writeFileSync(path.join(vault, "Alpha.md"), `# Alpha\n${"long changed line\n".repeat(20_000)}`);
    const bounded = await service.diff({ mode: "head", paths: ["Alpha.md"], maxBytes: 1024 });
    expect(bounded).toContain("truncated at 1024 bytes");
    expect(Buffer.byteLength(bounded)).toBeLessThan(2048);
    expect(await service.log({ limit: 1 })).toContain("Initial vault");
  });

  it("operates on one operator-selected nested repository while keeping Git paths repository-relative", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "oe-nested-repo-test-"));
    tempRoots.push(root);
    const vault = path.join(root, "Whole Vault");
    const repository = path.join(vault, "DSLab");
    mkdirSync(repository, { recursive: true });
    writeFileSync(path.join(vault, "Outside.md"), "# Outside\n");
    writeFileSync(path.join(repository, "Note.md"), "# Note\n\nInitial.\n");
    git(root, ["init", "--template=", "--initial-branch=main", repository]);
    git(repository, ["config", "user.name", "OE Test"]);
    git(repository, ["config", "user.email", "oe@example.invalid"]);
    git(repository, ["add", "--", "Note.md"]);
    git(repository, ["commit", "-m", "Initial nested repository"]);
    writeFileSync(path.join(repository, "Note.md"), "# Note\n\nChanged.\n");

    const service = new VaultGit(vault, { repositoryPath: "DSLab" });
    const status = await service.status();
    expect(status).toContain("Repository: DSLab");
    expect(status).toContain(" M Note.md");
    expect(status).not.toContain("Outside.md");
    expect(await service.diff({ paths: ["Note.md"] })).toContain("+Changed.");
    await expect(service.diff({ paths: ["DSLab/Note.md"] })).rejects.toThrow(/not currently changed/i);

    expect(() => new VaultGit(vault, { repositoryPath: "../outside" })).toThrow(/repository path/i);
    expect(() => new VaultGit(vault, { repositoryPath: "DSLab/../Other" })).toThrow(/repository path/i);
    if (process.platform !== "win32") {
      const linked = path.join(vault, "Linked");
      symlinkSync(repository, linked, "dir");
      expect(() => new VaultGit(vault, { repositoryPath: "Linked" })).toThrow(/real directories/i);
    }
  });

  it("fails closed if the selected repository path is replaced by a symlink after startup", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(path.join(os.tmpdir(), "oe-nested-repo-swap-test-"));
    tempRoots.push(root);
    const vault = path.join(root, "vault");
    const repository = path.join(vault, "DSLab");
    const outside = path.join(root, "outside");
    mkdirSync(repository, { recursive: true });
    mkdirSync(outside);
    for (const directory of [repository, outside]) {
      writeFileSync(path.join(directory, "Note.md"), "initial\n");
      git(directory, ["init", "--template=", "--initial-branch=main"]);
      git(directory, ["config", "user.name", "OE Test"]);
      git(directory, ["config", "user.email", "oe@example.invalid"]);
      git(directory, ["add", "Note.md"]);
      git(directory, ["commit", "-m", "Initial"]);
    }

    const service = new VaultGit(vault, { repositoryPath: "DSLab" });
    renameSync(repository, path.join(vault, "Original"));
    symlinkSync(outside, repository, "dir");
    writeFileSync(path.join(outside, "Note.md"), "outside changed\n");

    await expect(service.status()).rejects.toThrow(/symbolic link|identity changed/i);
  });

  it("refuses a parent repository, pathspec magic, and hidden paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "oe-parent-git-test-"));
    tempRoots.push(root);
    const vault = path.join(root, "nested-vault");
    mkdirSync(vault);
    writeFileSync(path.join(vault, "Note.md"), "hello\n");
    git(root, ["init", "--template=", "--initial-branch=main"]);
    const service = new VaultGit(vault);
    await expect(service.status()).rejects.toThrow(/missing .git directory/i);

    const own = createRepository().vault;
    const ownService = new VaultGit(own);
    await expect(ownService.diff({ paths: [":(glob)**"] })).rejects.toThrow(/pathspec magic/i);
    await expect(ownService.diff({ paths: [".obsidian/app.json"] })).rejects.toThrow(/hidden, excluded, or sensitive/i);
    await expect(ownService.diff({ paths: ["Folder"] })).rejects.toThrow(/not currently changed/i);
  });

  it("refuses Git object metadata redirected outside the repository .git directory", async () => {
    if (process.platform === "win32") return;
    const { root, vault } = createRepository();
    const objects = path.join(vault, ".git", "objects");
    const externalObjects = path.join(root, "external-objects");
    renameSync(objects, externalObjects);
    symlinkSync(externalObjects, objects, "dir");

    await expect(new VaultGit(vault).status()).rejects.toThrow(/\.git\/objects must be a real directory/i);
  });

  it("refuses alternate object stores for read-mode tools", async () => {
    const first = createRepository();
    const second = createRepository();
    writeFileSync(
      path.join(first.vault, ".git", "objects", "info", "alternates"),
      `${path.join(second.vault, ".git", "objects")}\n`,
    );
    const service = new VaultGit(first.vault);
    await expect(service.status()).rejects.toThrow(/alternate object stores/i);
    await expect(service.log()).rejects.toThrow(/alternate object stores/i);
  });

  it("fails closed when a tracked filename contains a line break", async () => {
    if (process.platform === "win32") return;
    const { vault } = createRepository();
    const unusual = "line\nbreak.md";
    writeFileSync(path.join(vault, unusual), "initial\n");
    git(vault, ["add", unusual]);
    git(vault, ["commit", "-m", "add unusual path"]);
    writeFileSync(path.join(vault, unusual), "changed\n");
    const status = await new VaultGit(vault).status();
    expect(status).toContain("Safe changes: 0");
    expect(status).toContain("Hidden/excluded/sensitive changes omitted: 1");
    expect(status).not.toContain(unusual);
  });

  it("creates only the explicitly previewed commit and preserves unrelated staged changes", async () => {
    const { vault } = createRepository();
    writeFileSync(path.join(vault, "Alpha.md"), "# Alpha\n\nSelected change.\n");
    writeFileSync(path.join(vault, "Unrelated.md"), "# Unrelated\n\nAlready staged.\n");
    git(vault, ["add", "--", "Unrelated.md"]);
    const hookSentinel = path.join(vault, "hook-ran");
    const hook = path.join(vault, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nprintf ran > "${hookSentinel}"\nexit 1\n`);
    if (process.platform !== "win32") chmodSync(hook, 0o755);

    const service = new VaultGit(vault);
    const preview = await service.previewCommit({ message: "feat: literal $(touch nope)", paths: ["Alpha.md"] });
    expect(preview).toContain("No commit was created");
    const result = await service.commit(approvalId(preview));
    expect(result).toContain("Vault Git Commit Created");
    expect(git(vault, ["show", "--pretty=format:", "--name-only", "HEAD"])).toBe("Alpha.md");
    expect(git(vault, ["diff", "--cached", "--name-only"])).toBe("Unrelated.md");
    expect(git(vault, ["log", "-1", "--pretty=%s"])).toBe("feat: literal $(touch nope)");
    expect(existsSync(hookSentinel)).toBe(false);
    expect(existsSync(path.join(vault, "nope"))).toBe(false);
  });

  it("commits new, deleted, and renamed paths without including the old rename path twice", async () => {
    const { vault } = createRepository();
    writeFileSync(path.join(vault, "New.md"), "# New\n");
    git(vault, ["mv", "Alpha.md", "Renamed.md"]);
    unlinkSync(path.join(vault, "Unrelated.md"));
    const service = new VaultGit(vault);
    const preview = await service.previewCommit({
      message: "vault lifecycle",
      paths: ["Renamed.md", "New.md", "Unrelated.md"],
    });
    await service.commit(approvalId(preview));
    expect(git(vault, ["show", "--pretty=format:", "--name-status", "HEAD"])).toMatch(/A\s+New\.md/);
    expect(git(vault, ["show", "--pretty=format:", "--name-status", "HEAD"])).toMatch(/R\d+\s+Alpha\.md\s+Renamed\.md/);
    expect(git(vault, ["show", "--pretty=format:", "--name-status", "HEAD"])).toMatch(/D\s+Unrelated\.md/);
  });

  it("creates the first commit on an unborn branch", async () => {
    const vault = mkdtempSync(path.join(os.tmpdir(), "oe-unborn-git-test-"));
    tempRoots.push(vault);
    writeFileSync(path.join(vault, "First.md"), "# First\n");
    git(vault, ["init", "--template=", "--initial-branch=main"]);
    git(vault, ["config", "user.name", "OE Test"]);
    git(vault, ["config", "user.email", "oe@example.invalid"]);
    const service = new VaultGit(vault);
    const diff = await service.diff({ mode: "head", paths: ["First.md"] });
    expect(diff).toContain("+# First");
    const preview = await service.previewCommit({ message: "Initial vault", paths: ["First.md"] });
    expect(preview).toContain("HEAD: (unborn)");
    await service.commit(approvalId(preview));
    expect(git(vault, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(vault, ["show", "--pretty=format:", "--name-only", "HEAD"])).toBe("First.md");
  });

  it("creates an unborn SHA-256 repository commit without assuming SHA-1 object length", async () => {
    const vault = mkdtempSync(path.join(os.tmpdir(), "oe-sha256-git-test-"));
    tempRoots.push(vault);
    writeFileSync(path.join(vault, "First.md"), "# SHA-256\n");
    git(vault, ["init", "--template=", "--object-format=sha256", "--initial-branch=main"]);
    git(vault, ["config", "user.name", "OE Test"]);
    git(vault, ["config", "user.email", "oe@example.invalid"]);
    const service = new VaultGit(vault);
    const preview = await service.previewCommit({ message: "Initial SHA-256 vault", paths: ["First.md"] });
    await service.commit(approvalId(preview));
    expect(git(vault, ["rev-parse", "--show-object-format"])).toBe("sha256");
    expect(git(vault, ["rev-parse", "HEAD"])).toHaveLength(64);
  });

  it("renders an explicit untracked file as an exact proposed head diff", async () => {
    const { vault } = createRepository();
    writeFileSync(path.join(vault, "New.md"), "# New\n\nUntracked content.\n");
    const diff = await new VaultGit(vault).diff({ mode: "head", paths: ["New.md"] });
    expect(diff).toContain("new file mode 100644");
    expect(diff).toContain("+Untracked content.");
  });

  it("invalidates one-use approvals when selected content changes", async () => {
    const { vault } = createRepository();
    writeFileSync(path.join(vault, "Alpha.md"), "first\n");
    const service = new VaultGit(vault);
    const preview = await service.previewCommit({ message: "first", paths: ["Alpha.md"] });
    writeFileSync(path.join(vault, "Alpha.md"), "second\n");
    await expect(service.commit(approvalId(preview))).rejects.toThrow(/state changed after preview/i);
    await expect(service.commit(approvalId(preview))).rejects.toThrow(/invalid, expired, or already used/i);
  });

  it("rejects an approved commit if the Git metadata directory is replaced after preview", async () => {
    const { vault } = createRepository();
    writeFileSync(path.join(vault, "Alpha.md"), "changed after preview\n");
    const service = new VaultGit(vault);
    const preview = await service.previewCommit({ message: "safe preview", paths: ["Alpha.md"] });
    const dotGit = path.join(vault, ".git");
    renameSync(dotGit, path.join(vault, ".git-original"));
    mkdirSync(dotGit);

    await expect(service.commit(approvalId(preview))).rejects.toThrow(/metadata directory identity changed/i);
  });

  it("expires commit approvals before they can change the repository", async () => {
    const { vault } = createRepository();
    writeFileSync(path.join(vault, "Alpha.md"), "expiring change\n");
    let now = 1_000;
    const service = new VaultGit(vault, { approvalTtlMs: 10, now: () => now });
    const preview = await service.previewCommit({ message: "expiring approval", paths: ["Alpha.md"] });
    const headBefore = git(vault, ["rev-parse", "HEAD"]);

    now += 11;
    await expect(service.commit(approvalId(preview))).rejects.toThrow(/invalid, expired, or already used/i);
    expect(git(vault, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(vault, ["diff", "--", "Alpha.md"])).toContain("+expiring change");
  });

  it("binds commit approval to file mode and effective attributes", async () => {
    const { vault } = createRepository();
    writeFileSync(path.join(vault, "Alpha.md"), "line one\r\nline two\r\n");
    const service = new VaultGit(vault);
    const modePreview = await service.previewCommit({ message: "review mode", paths: ["Alpha.md"] });
    if (process.platform !== "win32") {
      chmodSync(path.join(vault, "Alpha.md"), 0o755);
      await expect(service.commit(approvalId(modePreview))).rejects.toThrow(/state changed after preview/i);
      chmodSync(path.join(vault, "Alpha.md"), 0o644);
    }

    const attributesPreview = await service.previewCommit({ message: "review attributes", paths: ["Alpha.md"] });
    writeFileSync(path.join(vault, ".gitattributes"), "Alpha.md text eol=lf\n");
    await expect(service.commit(approvalId(attributesPreview))).rejects.toThrow(/state changed after preview/i);
  });

  it("refuses any unresolved index entry even when a different file was selected", async () => {
    const { vault } = createRepository();
    git(vault, ["checkout", "-b", "conflict-side"]);
    writeFileSync(path.join(vault, "Unrelated.md"), "side\n");
    git(vault, ["add", "Unrelated.md"]);
    git(vault, ["commit", "-m", "side"]);
    git(vault, ["checkout", "main"]);
    writeFileSync(path.join(vault, "Unrelated.md"), "main\n");
    git(vault, ["add", "Unrelated.md"]);
    git(vault, ["commit", "-m", "main"]);
    expect(() => git(vault, ["merge", "conflict-side"])).toThrow();
    unlinkSync(path.join(vault, ".git", "MERGE_HEAD"));
    writeFileSync(path.join(vault, "Alpha.md"), "selected\n");
    await expect(
      new VaultGit(vault).previewCommit({ message: "must not skip conflict", paths: ["Alpha.md"] }),
    ).rejects.toThrow(/unmerged index entry/i);
  });

  it("blocks clean filters and likely secrets without echoing the value", async () => {
    const { vault } = createRepository();
    writeFileSync(path.join(vault, ".gitattributes"), "Alpha.md filter=unsafe\n");
    writeFileSync(path.join(vault, "Alpha.md"), "changed\n");
    const service = new VaultGit(vault);
    await expect(service.previewCommit({ message: "filtered", paths: ["Alpha.md"] })).rejects.toThrow(/clean filters/i);

    writeFileSync(path.join(vault, ".gitattributes"), "");
    const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    writeFileSync(path.join(vault, "Alpha.md"), `${token}\n`);
    await expect(service.previewCommit({ message: "secret", paths: ["Alpha.md"] })).rejects.toThrow(
      /Possible GitHub token detected/,
    );
    try {
      await service.previewCommit({ message: "secret", paths: ["Alpha.md"] });
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });

  it("blocks a clean-filter command before status or diff can execute it", async () => {
    if (process.platform === "win32") return;
    const { vault } = createRepository();
    const sentinel = path.join(path.dirname(vault), "clean-filter-ran");
    writeFileSync(path.join(vault, ".gitattributes"), "Alpha.md filter=evil\n");
    git(vault, ["config", "filter.evil.clean", `sh -c 'touch "${sentinel}"; cat'`]);
    writeFileSync(path.join(vault, "Alpha.md"), "changed\n");
    const service = new VaultGit(vault);
    await expect(service.status()).rejects.toThrow(/clean filters/i);
    await expect(service.diff({ mode: "head", paths: ["Alpha.md"] })).rejects.toThrow(/clean filters/i);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("rejects repository-local config includes before an included helper can run", async () => {
    const { root, vault } = createRepository();
    const sentinel = path.join(root, "included-helper-ran");
    const included = path.join(root, "included.conf");
    writeFileSync(included, `[credential]\n\thelper = !touch ${sentinel}\n`);
    git(vault, ["config", "--local", "include.path", included]);
    await expect(new VaultGit(vault).status()).rejects.toThrow(/include\/includeIf/i);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("rejects secrets in new commit messages without echoing them", async () => {
    const { vault } = createRepository();
    writeFileSync(path.join(vault, "Alpha.md"), "changed\n");
    const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    try {
      await new VaultGit(vault).previewCommit({ message: `safe subject ${token}`, paths: ["Alpha.md"] });
      throw new Error("expected secret message rejection");
    } catch (error) {
      expect(String(error)).toContain("Possible GitHub token");
      expect(String(error)).not.toContain(token);
    }
    await expect(
      new VaultGit(vault).previewCommit({ message: "subject\nhidden body", paths: ["Alpha.md"] }),
    ).rejects.toThrow(/single line/i);
  });

  it("previews and pushes only the approved current HEAD to an allowlisted remote", async () => {
    const { vault, remote } = createRepository({ remote: true });
    git(vault, ["push", "origin", "main:release"]);
    git(vault, ["branch", "--set-upstream-to=origin/release", "main"]);
    writeFileSync(path.join(vault, "Alpha.md"), "# Alpha\n\nPushed.\n");
    git(vault, ["add", "--", "Alpha.md"]);
    git(vault, ["commit", "-m", "Ready to push"]);
    const prePushSentinel = path.join(vault, "pre-push-ran");
    const prePushHook = path.join(vault, ".git", "hooks", "pre-push");
    writeFileSync(prePushHook, `#!/bin/sh\nprintf ran > "${prePushSentinel}"\nexit 1\n`);
    if (process.platform !== "win32") chmodSync(prePushHook, 0o755);

    const service = new VaultGit(vault, {
      allowedPushTargets: [{ remote: "origin", url: remote! }],
      allowedPushProtocols: ["file"],
    });
    const preview = await service.previewPush();
    expect(preview).toContain("Network was not contacted");
    expect(preview).toContain("Outgoing commits: 1");
    const result = await service.push(approvalId(preview));
    expect(result).toContain("Vault Git Push Complete");
    expect(result).not.toContain(remote!);
    expect(git(remote!, ["show", "release:Alpha.md"])).toContain("Pushed.");
    expect(git(remote!, ["show", "main:Alpha.md"])).toContain("Initial.");
    expect(existsSync(prePushSentinel)).toBe(false);
  });

  it("does not expose push without an allowed remote or accept an unsafe protocol", async () => {
    const { vault } = createRepository({ remote: true });
    writeFileSync(path.join(vault, "Alpha.md"), "change\n");
    git(vault, ["add", "Alpha.md"]);
    git(vault, ["commit", "-m", "change"]);
    await expect(new VaultGit(vault).previewPush()).rejects.toThrow(
      /not in OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES/i,
    );
    await expect(
      new VaultGit(vault, {
        allowedPushTargets: [{ remote: "origin", url: "https://example.invalid/vault.git" }],
      }).previewPush(),
    ).rejects.toThrow(/HTTPS URL/i);
    git(vault, ["remote", "set-url", "origin", "https://user:secret@example.invalid/private.git"]);
    await expect(
      new VaultGit(vault, {
        allowedPushTargets: [{ remote: "origin", url: "https://example.invalid/vault.git" }],
      }).previewPush(),
    ).rejects.toThrow(/must not embed credentials/i);
  });

  it("rejects executable repository-local push configuration without running it", async () => {
    const { vault } = createRepository({ remote: true });
    const sentinel = path.join(vault, "credential-helper-ran");
    writeFileSync(path.join(vault, "Alpha.md"), "change\n");
    git(vault, ["add", "Alpha.md"]);
    git(vault, ["commit", "-m", "change"]);
    git(vault, ["config", "--local", "credential.helper", `!sh -c 'touch ${sentinel}'`]);
    const service = new VaultGit(vault, {
      allowedPushTargets: [{ remote: "origin", url: path.join(path.dirname(vault), "remote.git") }],
      allowedPushProtocols: ["file"],
    });
    await expect(service.previewPush()).rejects.toThrow(/repository-local credential helpers/i);
    expect(existsSync(sentinel)).toBe(false);
  });

  it.each([
    ["http.https://example.invalid/.sslVerify", "false"],
    ["http.https://example.invalid/.followRedirects", "true"],
    ["http.https://example.invalid/.curloptResolve", "example.invalid:443:127.0.0.1"],
    ["http.https://example.invalid/.proxy", "http://127.0.0.1:9"],
    ["http.https://example.invalid/.extraHeader", "X-Vault-Git-Review: unsafe"],
  ])("rejects repository-local HTTP transport override %s", async (key, value) => {
    const { vault, remote } = createRepository({ remote: true });
    writeFileSync(path.join(vault, "Alpha.md"), "change\n");
    git(vault, ["add", "Alpha.md"]);
    git(vault, ["commit", "-m", "change"]);
    git(vault, ["config", "--local", key, value]);
    const service = new VaultGit(vault, {
      allowedPushTargets: [{ remote: "origin", url: remote! }],
      allowedPushProtocols: ["file"],
    });

    await expect(service.previewPush()).rejects.toThrow(/repository-local http\.\*/i);
  });

  it("rechecks repository-local HTTP transport policy after push preview", async () => {
    const { vault, remote } = createRepository({ remote: true });
    writeFileSync(path.join(vault, "Alpha.md"), "approved content\n");
    git(vault, ["add", "Alpha.md"]);
    git(vault, ["commit", "-m", "approved content"]);
    const service = new VaultGit(vault, {
      allowedPushTargets: [{ remote: "origin", url: remote! }],
      allowedPushProtocols: ["file"],
    });
    const preview = await service.previewPush();
    git(vault, ["config", "--local", "http.https://example.invalid/.sslVerify", "false"]);

    await expect(service.push(approvalId(preview))).rejects.toThrow(/repository-local http\.\*/i);
    expect(git(remote!, ["show", "main:Alpha.md"])).toContain("Initial.");
  });

  it.each(["proxy", "proxyAuthMethod"])(
    "rejects the selected remote's repository-local %s override",
    async (setting) => {
      const { vault, remote } = createRepository({ remote: true });
      writeFileSync(path.join(vault, "Alpha.md"), "change\n");
      git(vault, ["add", "Alpha.md"]);
      git(vault, ["commit", "-m", "change"]);
      git(vault, ["config", "--local", `remote.origin.${setting}`, setting === "proxy" ? "none" : "basic"]);
      const service = new VaultGit(vault, {
        allowedPushTargets: [{ remote: "origin", url: remote! }],
        allowedPushProtocols: ["file"],
      });

      await expect(service.previewPush()).rejects.toThrow(new RegExp(`remote\\.origin\\.${setting}`, "i"));
    },
  );

  it("rejects unreviewed repository-local push options", async () => {
    const { vault, remote } = createRepository({ remote: true });
    writeFileSync(path.join(vault, "Alpha.md"), "change\n");
    git(vault, ["add", "Alpha.md"]);
    git(vault, ["commit", "-m", "change"]);
    git(vault, ["config", "--local", "push.pushOption", "ci.variable=UNREVIEWED"]);
    const service = new VaultGit(vault, {
      allowedPushTargets: [{ remote: "origin", url: remote! }],
      allowedPushProtocols: ["file"],
    });
    await expect(service.previewPush()).rejects.toThrow(/push\.pushOption/i);
  });

  it("blocks a secret added and deleted in older outgoing history", async () => {
    const { vault } = createRepository({ remote: true });
    const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    writeFileSync(path.join(vault, "Leaked.md"), `${token}\n`);
    git(vault, ["add", "Leaked.md"]);
    git(vault, ["commit", "-m", "add temporary note"]);
    unlinkSync(path.join(vault, "Leaked.md"));
    git(vault, ["add", "--all", "--", "Leaked.md"]);
    git(vault, ["commit", "-m", "remove temporary note"]);
    const service = new VaultGit(vault, {
      allowedPushTargets: [{ remote: "origin", url: path.join(path.dirname(vault), "remote.git") }],
      allowedPushProtocols: ["file"],
    });
    try {
      await service.previewPush();
      throw new Error("expected previewPush to reject outgoing secret history");
    } catch (error) {
      expect(String(error)).toContain("Possible GitHub token");
      expect(String(error)).not.toContain(token);
    }
  });

  it("blocks secrets introduced only by a merge result", async () => {
    const { vault, remote } = createRepository({ remote: true });
    git(vault, ["checkout", "-b", "side"]);
    writeFileSync(path.join(vault, "Alpha.md"), "safe side\n");
    git(vault, ["add", "Alpha.md"]);
    git(vault, ["commit", "-m", "safe side"]);
    git(vault, ["checkout", "main"]);
    writeFileSync(path.join(vault, "Alpha.md"), "safe main\n");
    git(vault, ["add", "Alpha.md"]);
    git(vault, ["commit", "-m", "safe main"]);
    expect(() => git(vault, ["merge", "side"])).toThrow();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    writeFileSync(path.join(vault, "Alpha.md"), `${token}\n`);
    git(vault, ["add", "Alpha.md"]);
    git(vault, ["commit", "-m", "resolve safely"]);
    const service = new VaultGit(vault, {
      allowedPushTargets: [{ remote: "origin", url: remote! }],
      allowedPushProtocols: ["file"],
    });
    try {
      await service.previewPush();
      throw new Error("expected merge-result secret rejection");
    } catch (error) {
      expect(String(error)).toContain("Possible GitHub token");
      expect(String(error)).not.toContain(token);
    }
  });

  it("blocks a secret hidden in an outgoing commit-message body", async () => {
    const { vault, remote } = createRepository({ remote: true });
    const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    writeFileSync(path.join(vault, "Alpha.md"), "safe change\n");
    git(vault, ["add", "Alpha.md"]);
    git(vault, ["commit", "-m", "safe subject", "-m", token]);
    const service = new VaultGit(vault, {
      allowedPushTargets: [{ remote: "origin", url: remote! }],
      allowedPushProtocols: ["file"],
    });
    try {
      await service.previewPush();
      throw new Error("expected outgoing message secret rejection");
    } catch (error) {
      expect(String(error)).toContain("outgoing commit message");
      expect(String(error)).not.toContain(token);
    }
  });

  it("blocks non-regular objects in outgoing history", async () => {
    if (process.platform === "win32") return;
    const { vault, remote } = createRepository({ remote: true });
    symlinkSync("Alpha.md", path.join(vault, "Linked.md"));
    git(vault, ["add", "Linked.md"]);
    git(vault, ["commit", "-m", "add link"]);
    const service = new VaultGit(vault, {
      allowedPushTargets: [{ remote: "origin", url: remote! }],
      allowedPushProtocols: ["file"],
    });
    await expect(service.previewPush()).rejects.toThrow(/non-regular Git object/i);
  });

  it("uses an exact remote-OID lease so a deleted upstream is not recreated", async () => {
    const { vault, remote } = createRepository({ remote: true });
    writeFileSync(path.join(vault, "Alpha.md"), "safe change\n");
    git(vault, ["add", "Alpha.md"]);
    git(vault, ["commit", "-m", "safe change"]);
    const service = new VaultGit(vault, {
      allowedPushTargets: [{ remote: "origin", url: remote! }],
      allowedPushProtocols: ["file"],
    });
    const preview = await service.previewPush();
    git(remote!, ["update-ref", "-d", "refs/heads/main"]);
    try {
      await service.push(approvalId(preview));
      throw new Error("expected exact-lease rejection");
    } catch (error) {
      expect(String(error)).not.toContain(remote!);
    }
    expect(() => git(remote!, ["rev-parse", "--verify", "refs/heads/main"])).toThrow();
  });
});
