import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

async function readJson(relativePath) {
  const source = await readFile(new URL(relativePath, new URL("../", import.meta.url)), "utf8");
  return JSON.parse(source);
}

function fail(message) {
  console.error(`Release version verification failed: ${message}`);
  process.exitCode = 1;
}

const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const serverJson = await readJson("server.json");
const versionSource = await readFile(new URL("../src/version.ts", import.meta.url), "utf8");

const sourceMatch = versionSource.match(/^export const VERSION = ["']([^"']+)["'];\s*$/u);
const canonicalVersion = packageJson.version;
const expectedVersion = process.argv[2];
const checks = [
  ["package.json version", canonicalVersion],
  ["package-lock.json version", packageLock.version],
  ["package-lock.json packages[''] version", packageLock.packages?.[""]?.version],
  ["server.json version", serverJson.version],
  ["server.json package version", serverJson.packages?.[0]?.version],
  ["src/version.ts VERSION", sourceMatch?.[1]],
];

if (typeof canonicalVersion !== "string" || canonicalVersion.length === 0) {
  fail("package.json must contain a non-empty string version.");
} else {
  for (const [label, value] of checks.slice(1)) {
    if (value !== canonicalVersion) {
      fail(`${label} is ${JSON.stringify(value)}, expected ${canonicalVersion}.`);
    }
  }

  if (expectedVersion !== undefined && expectedVersion !== canonicalVersion) {
    fail(`requested version is ${expectedVersion}, expected ${canonicalVersion}.`);
  }

  if (process.env.GITHUB_REF_TYPE === "tag") {
    const expectedTag = `v${canonicalVersion}`;
    if (process.env.GITHUB_REF_NAME !== expectedTag) {
      fail(`release tag is ${JSON.stringify(process.env.GITHUB_REF_NAME)}, expected ${expectedTag}.`);
    }
  }
}

if (process.exitCode) {
  console.error(`Checked release metadata from ${projectRoot}`);
} else {
  console.log(`Release version verified: v${canonicalVersion}`);
}
