function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/** All write tools are on by default; set OBSIDIAN_EVERYWHERE_READONLY=true to disable them. */
export function writeToolsEnabledByDefault(): boolean {
  return !isTruthyEnv(process.env.OBSIDIAN_EVERYWHERE_READONLY);
}

/** The OAuth (public connector) entrypoint inverts the default — write tools are off unless explicitly opted into. */
export function oauthWriteToolsEnabled(): boolean {
  return isTruthyEnv(process.env.OAUTH_ENABLE_WRITE_TOOLS);
}
