import { afterEach, describe, expect, it } from "vitest";
import {
  mountGuardConfigFromEnv,
  oauthWriteToolsEnabled,
  semanticSearchEnabledFromEnv,
  writeToolsEnabledByDefault,
} from "./env.js";

const ORIGINAL_READONLY = process.env.OBSIDIAN_EVERYWHERE_READONLY;
const ORIGINAL_OAUTH_WRITE = process.env.OAUTH_ENABLE_WRITE_TOOLS;
const ORIGINAL_REQUIRE_NONEMPTY = process.env.OBSIDIAN_EVERYWHERE_REQUIRE_NONEMPTY_VAULT;
const ORIGINAL_MOUNT_GUARD = process.env.OBSIDIAN_EVERYWHERE_MOUNT_GUARD;
const ORIGINAL_MOUNT_SENTINEL = process.env.OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL;
const ORIGINAL_MOUNT_RECHECK = process.env.OBSIDIAN_EVERYWHERE_MOUNT_RECHECK_MS;
const ORIGINAL_SEMANTIC = process.env.OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC;

afterEach(() => {
  if (ORIGINAL_READONLY === undefined) delete process.env.OBSIDIAN_EVERYWHERE_READONLY;
  else process.env.OBSIDIAN_EVERYWHERE_READONLY = ORIGINAL_READONLY;
  if (ORIGINAL_OAUTH_WRITE === undefined) delete process.env.OAUTH_ENABLE_WRITE_TOOLS;
  else process.env.OAUTH_ENABLE_WRITE_TOOLS = ORIGINAL_OAUTH_WRITE;
  if (ORIGINAL_REQUIRE_NONEMPTY === undefined) delete process.env.OBSIDIAN_EVERYWHERE_REQUIRE_NONEMPTY_VAULT;
  else process.env.OBSIDIAN_EVERYWHERE_REQUIRE_NONEMPTY_VAULT = ORIGINAL_REQUIRE_NONEMPTY;
  if (ORIGINAL_MOUNT_GUARD === undefined) delete process.env.OBSIDIAN_EVERYWHERE_MOUNT_GUARD;
  else process.env.OBSIDIAN_EVERYWHERE_MOUNT_GUARD = ORIGINAL_MOUNT_GUARD;
  if (ORIGINAL_MOUNT_SENTINEL === undefined) delete process.env.OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL;
  else process.env.OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL = ORIGINAL_MOUNT_SENTINEL;
  if (ORIGINAL_MOUNT_RECHECK === undefined) delete process.env.OBSIDIAN_EVERYWHERE_MOUNT_RECHECK_MS;
  else process.env.OBSIDIAN_EVERYWHERE_MOUNT_RECHECK_MS = ORIGINAL_MOUNT_RECHECK;
  if (ORIGINAL_SEMANTIC === undefined) delete process.env.OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC;
  else process.env.OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC = ORIGINAL_SEMANTIC;
});

describe("semanticSearchEnabledFromEnv", () => {
  it("defaults to the low-memory disabled state", () => {
    delete process.env.OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC;
    expect(semanticSearchEnabledFromEnv()).toBe(false);
  });

  it("accepts an explicit opt-in", () => {
    process.env.OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC = "true";
    expect(semanticSearchEnabledFromEnv()).toBe(true);
  });
});

describe("mountGuardConfigFromEnv", () => {
  it("defaults to disabled so genuinely empty vaults still work", () => {
    delete process.env.OBSIDIAN_EVERYWHERE_MOUNT_GUARD;
    delete process.env.OBSIDIAN_EVERYWHERE_REQUIRE_NONEMPTY_VAULT;
    expect(mountGuardConfigFromEnv()).toEqual({ enabled: false, sentinel: undefined, recheckIntervalMs: 5000 });
  });

  it("supports the public flag, sentinel, and interval", () => {
    process.env.OBSIDIAN_EVERYWHERE_MOUNT_GUARD = "true";
    process.env.OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL = ".obsidian/app.json";
    process.env.OBSIDIAN_EVERYWHERE_MOUNT_RECHECK_MS = "2500";
    expect(mountGuardConfigFromEnv()).toEqual({
      enabled: true,
      sentinel: ".obsidian/app.json",
      recheckIntervalMs: 2500,
    });
  });

  it("keeps the old require-nonempty flag as a compatibility alias", () => {
    delete process.env.OBSIDIAN_EVERYWHERE_MOUNT_GUARD;
    process.env.OBSIDIAN_EVERYWHERE_REQUIRE_NONEMPTY_VAULT = "1";
    expect(mountGuardConfigFromEnv().enabled).toBe(true);
  });

  it("rejects unsafe sentinel paths", () => {
    process.env.OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL = "../outside";
    expect(() => mountGuardConfigFromEnv()).toThrow("safe vault-relative path");
  });
});

describe("writeToolsEnabledByDefault (stdio/bearer-http)", () => {
  it("defaults to enabled when unset", () => {
    delete process.env.OBSIDIAN_EVERYWHERE_READONLY;
    expect(writeToolsEnabledByDefault()).toBe(true);
  });

  it("disables when set to true", () => {
    process.env.OBSIDIAN_EVERYWHERE_READONLY = "true";
    expect(writeToolsEnabledByDefault()).toBe(false);
  });

  it("disables when set to 1", () => {
    process.env.OBSIDIAN_EVERYWHERE_READONLY = "1";
    expect(writeToolsEnabledByDefault()).toBe(false);
  });

  it("stays enabled for unrecognized values", () => {
    process.env.OBSIDIAN_EVERYWHERE_READONLY = "nope";
    expect(writeToolsEnabledByDefault()).toBe(true);
  });
});

describe("oauthWriteToolsEnabled (public OAuth connector — inverted default)", () => {
  it("defaults to disabled when unset", () => {
    delete process.env.OAUTH_ENABLE_WRITE_TOOLS;
    expect(oauthWriteToolsEnabled()).toBe(false);
  });

  it("enables when explicitly set to true", () => {
    process.env.OAUTH_ENABLE_WRITE_TOOLS = "true";
    expect(oauthWriteToolsEnabled()).toBe(true);
  });
});
