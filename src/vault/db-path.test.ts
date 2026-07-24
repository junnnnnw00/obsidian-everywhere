import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDbPath } from "./db-path.js";

describe("resolveDbPath", () => {
  const origEnv = process.env.OBSIDIAN_EVERYWHERE_DB;

  beforeEach(() => {
    delete process.env.OBSIDIAN_EVERYWHERE_DB;
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.OBSIDIAN_EVERYWHERE_DB = origEnv;
    } else {
      delete process.env.OBSIDIAN_EVERYWHERE_DB;
    }
  });

  it("prioritizes process.env.OBSIDIAN_EVERYWHERE_DB if set", () => {
    process.env.OBSIDIAN_EVERYWHERE_DB = "/custom/path/db.sqlite";
    expect(resolveDbPath("/Volumes/External/vault", "index.db")).toBe("/custom/path/db.sqlite");
  });

  it("resolves external volume paths (/Volumes/...) to home dir", () => {
    const res = resolveDbPath("/Volumes/MyPassport/jwhong", "index-http.db");
    expect(res).toContain(path.join(os.homedir(), ".obsidian-everywhere"));
    expect(res).toContain("index-http.db");
  });

  it("resolves local paths to inside vault", () => {
    const res = resolveDbPath("/Users/junwoo/vault", "index-http.db");
    expect(res).toBe(path.join("/Users/junwoo/vault", ".obsidian-everywhere", "index-http.db"));
  });
});
