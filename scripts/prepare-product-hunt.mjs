#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const productHuntDir = join(root, "product-hunt");
const outputDir = join(productHuntDir, "dist");
const launchPath = join(productHuntDir, "launch.json");
const launch = JSON.parse(readFileSync(launchPath, "utf8"));
const demoInput = "assets/remote-vault-bridge-demo.mp4";
const expectedDemoSeconds = 44;
const productHuntAssetLimit = 3_000_000;

const failures = [];
if (!launch.name?.trim()) failures.push("name is required");
if (!launch.url?.startsWith("https://")) failures.push("url must be an HTTPS URL");
if (/utm_|bit\.ly|t\.co/i.test(launch.url ?? "")) failures.push("url must not be shortened or tracked");
if (launch.productPageUrl !== null && !launch.productPageUrl?.startsWith("https://www.producthunt.com/")) {
  failures.push("productPageUrl must be null or an HTTPS producthunt.com URL");
}
if (launch.launchMode !== "existing-product-new-launch") {
  failures.push("launchMode must be existing-product-new-launch to preserve prior launch history");
}
if (launch.assetPolicy !== "static-gallery-only") {
  failures.push("assetPolicy must be static-gallery-only");
}
if (!launch.tagline?.trim() || launch.tagline.length > 60) failures.push("tagline must be 1–60 characters");
if (!launch.description?.trim() || launch.description.length > 260)
  failures.push("description must be 1–260 characters");
if (!Array.isArray(launch.topics) || launch.topics.length < 1 || launch.topics.length > 3) {
  failures.push("topics must contain 1–3 entries");
}
if (launch.topics?.some((topic) => typeof topic !== "string" || !topic.trim())) {
  failures.push("every topic must be a non-empty string");
}
if (!launch.firstComment?.trim()) failures.push("firstComment is required");
if (/\b(upvote|upvotes)\b/i.test(launch.firstComment ?? "")) {
  failures.push("firstComment must ask for feedback, not upvotes");
}
if (!launch.readmeDemoUrl?.startsWith("https://")) {
  failures.push("readmeDemoUrl must be an HTTPS URL");
}
if (!launch.firstComment?.includes(launch.readmeDemoUrl ?? "\0")) {
  failures.push("firstComment must link to readmeDemoUrl");
}
if (!launch.firstComment?.includes(`${expectedDemoSeconds}-second`)) {
  failures.push(`firstComment must describe the ${expectedDemoSeconds}-second demo`);
}
if (failures.length) {
  console.error(`Product Hunt launch data is invalid:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

const requiredInputs = [demoInput];
for (const relativePath of requiredInputs) {
  if (!existsSync(join(root, relativePath))) {
    console.error(`Missing required asset: ${relativePath}`);
    process.exit(1);
  }
}

const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (ffmpegCheck.status !== 0) {
  console.error("ffmpeg is required. Install it, then rerun npm run product-hunt:prepare.");
  process.exit(1);
}
const ffprobeCheck = spawnSync("ffprobe", ["-version"], { encoding: "utf8" });
if (ffprobeCheck.status !== 0) {
  console.error("ffprobe is required. Install it, then rerun npm run product-hunt:prepare.");
  process.exit(1);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(result.stderr || `ffmpeg failed: ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

function probeMedia(relativePath) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size",
      "-show_entries",
      "stream=codec_name,width,height,avg_frame_rate,nb_frames",
      "-of",
      "json",
      relativePath,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(result.stderr || `ffprobe failed: ${relativePath}`);
    process.exit(result.status ?? 1);
  }
  return JSON.parse(result.stdout);
}

function validateAsset(relativePath, { width, height, codec, maxBytes = productHuntAssetLimit }) {
  const absolutePath = join(root, relativePath);
  const probe = probeMedia(relativePath);
  const stream = probe.streams?.[0];
  const bytes = statSync(absolutePath).size;
  const assetFailures = [];
  if (stream?.width !== width || stream?.height !== height) {
    assetFailures.push(`expected ${width}×${height}, got ${stream?.width}×${stream?.height}`);
  }
  if (stream?.codec_name !== codec) {
    assetFailures.push(`expected ${codec}, got ${stream?.codec_name ?? "unknown codec"}`);
  }
  if (bytes >= maxBytes) {
    assetFailures.push(`must be under ${maxBytes.toLocaleString()} bytes, got ${bytes.toLocaleString()}`);
  }
  if (assetFailures.length) {
    console.error(`Invalid generated asset ${relativePath}:\n- ${assetFailures.join("\n- ")}`);
    process.exit(1);
  }
  return probe;
}

ffmpeg([
  "-ss",
  "42.0",
  "-i",
  demoInput,
  "-vf",
  "crop=190:120:545:73,scale=228:144:flags=lanczos,pad=240:240:6:48:color=0x090b0f",
  "-frames:v",
  "1",
  "product-hunt/dist/thumbnail.png",
]);
const galleryFrames = [
  {
    timestamp: "42.0",
    filename: "gallery-01-overview.png",
    purpose: "Core positioning and zero-install demo command",
  },
  {
    timestamp: "10.5",
    filename: "gallery-02-semantic-search.png",
    purpose: "Local semantic search used by a remote MCP client",
  },
  {
    timestamp: "16.8",
    filename: "gallery-03-graph-context.png",
    purpose: "Graph neighborhood plus a token-budgeted context bundle",
  },
  {
    timestamp: "25.6",
    filename: "gallery-04-guarded-edit.png",
    purpose: "A scoped note append held for explicit client approval",
  },
  {
    timestamp: "29.0",
    filename: "gallery-05-mount-guard.png",
    purpose: "Mount Guard preserving the index and blocking unsafe writes",
  },
  {
    timestamp: "38.5",
    filename: "gallery-06-recovered-write.png",
    purpose: "Approved retry, local note update, and immediate reindex",
  },
];
for (const { timestamp, filename } of galleryFrames) {
  ffmpeg([
    "-ss",
    timestamp,
    "-i",
    demoInput,
    "-vf",
    "scale=1270:760:force_original_aspect_ratio=decrease:flags=lanczos,pad=1270:760:(ow-iw)/2:(oh-ih)/2:color=0x090b0f",
    "-frames:v",
    "1",
    `product-hunt/dist/${filename}`,
  ]);
}

validateAsset("product-hunt/dist/thumbnail.png", { width: 240, height: 240, codec: "png" });
for (const { filename } of galleryFrames) {
  validateAsset(`product-hunt/dist/${filename}`, { width: 1270, height: 760, codec: "png" });
}

const galleryUploadOrder = galleryFrames
  .map(({ filename, purpose }, index) => `${index + 2}. \`${filename}\` — 1270×760 — ${purpose}`)
  .join("\n");

const submission = `# Product Hunt submission — ${launch.name}

Generated from \`product-hunt/launch.json\` and the ${expectedDemoSeconds}-second Remote Vault Bridge demo. The final Product Hunt Draft/Schedule action must be completed with a personal account.

## Core fields

- **URL:** ${launch.url}
- **Name:** ${launch.name}
- **Tagline (${launch.tagline.length}/60):** ${launch.tagline}
- **Topics:** ${launch.topics.join(", ")}
- **Pricing:** ${launch.pricing}
- **Status:** ${launch.status}
- **Existing product page:** ${launch.productPageUrl ?? "Select the claimed Obsidian Everywhere product in Product Hunt"}
- **Launch mode:** Existing product → New launch
- **Launch date:** ${launch.launchDate ?? "Leave unset until relaunch eligibility is confirmed"}

## Description (${launch.description.length}/260)

${launch.description}

## README demo

${launch.readmeDemoUrl}

Use this link in the first comment or launch-day sharing. It is not a Product Hunt video-field URL; the dedicated video field accepts only a full YouTube URL.

## First comment

${launch.firstComment}

## Upload order

1. \`thumbnail.png\` — 240×240 static product mark
${galleryUploadOrder}

This kit intentionally uses a static gallery only. Leave the dedicated video field empty unless a public, full YouTube URL is available.

## Automated checks

- tagline: ${launch.tagline.length}/60 characters
- description: ${launch.description.length}/260 characters
- topics: ${launch.topics.length}/3
- thumbnail: 240×240 PNG, under 3 MB
- gallery: ${galleryFrames.length} PNGs at 1270×760, each under 3 MB
- media policy: static gallery only; no GIF upload
- no shortened/tracked primary URL and no request for votes

## Final manual step

Open the already claimed Obsidian Everywhere product with a personal account, choose **New launch**, paste these fields, upload the static assets in order, add yourself as Maker, and choose **Create Draft**. Do not create a duplicate product and do not schedule the launch until the Beta has produced concrete compatibility feedback and Product Hunt's relaunch eligibility has been confirmed. Ask people to try the workflow and share feedback; do not ask them to vote.
`;

writeFileSync(join(outputDir, "submission.md"), submission);
writeFileSync(join(outputDir, "submission.json"), `${JSON.stringify(launch, null, 2)}\n`);

const outputFiles = readdirSync(outputDir).sort();
const hashes = outputFiles.map((filename) => {
  const contents = readFileSync(join(outputDir, filename));
  return `${createHash("sha256").update(contents).digest("hex")}  ${filename}`;
});
writeFileSync(join(outputDir, "SHA256SUMS"), `${hashes.join("\n")}\n`);

console.log(`Product Hunt launch kit created at ${outputDir}`);
for (const filename of readdirSync(outputDir).sort()) {
  const bytes = statSync(join(outputDir, filename)).size;
  console.log(`- ${filename} (${bytes.toLocaleString()} bytes)`);
}
