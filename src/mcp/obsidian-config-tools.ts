import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { VaultEngine } from "../vault-engine.js";
import { writeFileAtomic } from "../vault/write.js";

type JsonObject = Record<string, unknown>;

function configPath(engine: VaultEngine, filename: string): string {
  return path.join(engine.vaultDir, ".obsidian", filename);
}

function readJsonObject(absPath: string): JsonObject {
  if (!existsSync(absPath)) return {};
  const value: unknown = JSON.parse(readFileSync(absPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${absPath} must contain a JSON object`);
  return value as JsonObject;
}

function writeJsonObject(absPath: string, value: JsonObject): void {
  writeFileAtomic(absPath, `${JSON.stringify(value, null, 2)}\n`);
}

export function getHotkeys(engine: VaultEngine): string {
  try {
    const hotkeys = readJsonObject(configPath(engine, "hotkeys.json"));
    return JSON.stringify(
      {
        hotkeys,
        note: "These are user-configured command IDs; Obsidian does not persist its full runtime command registry.",
      },
      null,
      2,
    );
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export function getObsidianSettings(engine: VaultEngine): string {
  try {
    const templates = readJsonObject(configPath(engine, "templates.json"));
    const corePlugins = readJsonObject(configPath(engine, "core-plugins.json"));
    return JSON.stringify(
      {
        templateFolder: typeof templates.folder === "string" ? templates.folder : null,
        corePlugins,
        note: "Values are read from the vault's persisted .obsidian settings; runtime-only app state is not available to this standalone MCP process.",
      },
      null,
      2,
    );
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export interface HotkeyBinding {
  modifiers: ("Mod" | "Ctrl" | "Meta" | "Shift" | "Alt")[];
  key: string;
}

export function setHotkey(engine: VaultEngine, args: { commandId: string; hotkeys: HotkeyBinding[] }): string {
  const absPath = configPath(engine, "hotkeys.json");
  try {
    const config = readJsonObject(absPath);
    config[args.commandId] = args.hotkeys;
    writeJsonObject(absPath, config);
    return `Set ${args.hotkeys.length} hotkey binding(s) for ${args.commandId}. Obsidian may need to reload the vault before the change appears.`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

export function setTemplatesFolder(engine: VaultEngine, args: { folder: string }): string {
  const folder = args.folder.trim().replace(/^\/+|\/+$/g, "");
  if (!folder || folder.split("/").some((segment) => segment === "." || segment === "..")) {
    return "Error: folder must be a non-empty vault-relative folder path.";
  }
  const absPath = configPath(engine, "templates.json");
  try {
    const config = readJsonObject(absPath);
    config.folder = folder;
    writeJsonObject(absPath, config);
    return `Set the Templates core plugin folder to ${folder}. Obsidian may need to reload the vault before the change appears.`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
