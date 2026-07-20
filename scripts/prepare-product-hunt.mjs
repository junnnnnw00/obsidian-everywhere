#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const productHuntDir = join(root, "product-hunt");
const outputDir = join(productHuntDir, "dist");
const launchPath = join(productHuntDir, "launch.json");
const launch = JSON.parse(readFileSync(launchPath, "utf8"));

const failures = [];
if (!launch.name?.trim()) failures.push("name is required");
if (!launch.url?.startsWith("https://")) failures.push("url must be an HTTPS URL");
if (/utm_|bit\.ly|t\.co/i.test(launch.url ?? "")) failures.push("url must not be shortened or tracked");
if (!launch.tagline?.trim() || launch.tagline.length > 60) failures.push("tagline must be 1–60 characters");
if (!launch.description?.trim() || launch.description.length > 500)
  failures.push("description must be 1–500 characters");
if (!Array.isArray(launch.topics) || launch.topics.length < 1 || launch.topics.length > 3) {
  failures.push("topics must contain 1–3 entries");
}
if (!launch.firstComment?.trim()) failures.push("firstComment is required");
if (/\b(upvote|upvotes)\b/i.test(launch.firstComment ?? "")) {
  failures.push("firstComment must ask for feedback, not upvotes");
}
if (failures.length) {
  console.error(`Product Hunt launch data is invalid:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

const requiredInputs = ["assets/demo.gif"];
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

ffmpeg([
  "-ss",
  "6.3",
  "-i",
  "assets/demo.gif",
  "-vf",
  "scale=240:192:flags=lanczos,pad=240:240:0:24:color=0x0d0d10",
  "-frames:v",
  "1",
  "product-hunt/dist/thumbnail.png",
]);
const galleryFrames = [
  ["2.7", "gallery-01-context.png"],
  ["6.3", "gallery-02-related.png"],
  ["17.1", "gallery-03-link-safe-move.png"],
  ["20.7", "gallery-04-safe-bulk-edit.png"],
];
for (const [timestamp, filename] of galleryFrames) {
  ffmpeg([
    "-ss",
    timestamp,
    "-i",
    "assets/demo.gif",
    "-vf",
    "scale=950:760:force_original_aspect_ratio=decrease:flags=lanczos,pad=1270:760:(ow-iw)/2:(oh-ih)/2:color=0x0d0d10",
    "-frames:v",
    "1",
    `product-hunt/dist/${filename}`,
  ]);
}
copyFileSync(join(root, "assets/demo.gif"), join(outputDir, "interactive-demo.gif"));

const submission = `# Product Hunt submission — ${launch.name}

Generated from \`product-hunt/launch.json\`. The final Product Hunt Draft/Schedule action must be completed with a personal account.

## Core fields

- **URL:** ${launch.url}
- **Name:** ${launch.name}
- **Tagline (${launch.tagline.length}/60):** ${launch.tagline}
- **Topics:** ${launch.topics.join(", ")}
- **Pricing:** ${launch.pricing}
- **Status:** ${launch.status}
- **Launch date:** ${launch.launchDate ?? "Choose in Product Hunt (within 30 days)"}

## Description (${launch.description.length}/500)

${launch.description}

## First comment

${launch.firstComment}

## Upload order

1. \`thumbnail.png\` — 240×240 thumbnail
2. \`gallery-01-context.png\` — 1270×760
3. \`gallery-02-related.png\` — 1270×760
4. \`gallery-03-link-safe-move.png\` — 1270×760
5. \`gallery-04-safe-bulk-edit.png\` — 1270×760
6. \`interactive-demo.gif\` — optional full six-function demo

## Final manual step

Open Product Hunt with a personal account, create a new product, paste these fields, upload the assets in order, add yourself as Maker, and choose **Create Draft** or **Schedule Launch**. Ask for feedback in launch-day sharing; do not ask for upvotes.
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
