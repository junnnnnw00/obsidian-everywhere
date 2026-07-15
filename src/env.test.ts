import { afterEach, describe, expect, it } from "vitest";
import { oauthWriteToolsEnabled, writeToolsEnabledByDefault } from "./env.js";

const ORIGINAL_READONLY = process.env.OBSIDIAN_EVERYWHERE_READONLY;
const ORIGINAL_OAUTH_WRITE = process.env.OAUTH_ENABLE_WRITE_TOOLS;

afterEach(() => {
  if (ORIGINAL_READONLY === undefined) delete process.env.OBSIDIAN_EVERYWHERE_READONLY;
  else process.env.OBSIDIAN_EVERYWHERE_READONLY = ORIGINAL_READONLY;
  if (ORIGINAL_OAUTH_WRITE === undefined) delete process.env.OAUTH_ENABLE_WRITE_TOOLS;
  else process.env.OAUTH_ENABLE_WRITE_TOOLS = ORIGINAL_OAUTH_WRITE;
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
