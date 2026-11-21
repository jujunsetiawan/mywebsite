// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Copies the Story 0.3 published mediaVersion into public/media/ so Vite serves it:
//
//   pipeline/out/<mediaVersion>/**            -> public/media/<mediaVersion>/**
//   pipeline/out/<mediaVersion>/asset-manifest.json -> public/media/asset-manifest.json (entry point)
//
// Usage: node scripts/copy-media.mjs [mediaVersion]   (default spike-2026-11-21)
// The source is never modified. public/media/ is git-ignored.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const mediaVersion = process.argv[2] ?? "spike-2026-11-21";
const src = join(repoRoot, "pipeline", "out", mediaVersion);
const mediaRoot = resolve(here, "..", "public", "media");
const dest = join(mediaRoot, mediaVersion);

const manifestPath = join(src, "asset-manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`[copy-media] ${manifestPath} not found. Run the Story 0.3 pipeline first (pipeline/README.md).`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.mediaVersion !== mediaVersion) {
  console.error(`[copy-media] manifest mediaVersion ${manifest.mediaVersion} != directory ${mediaVersion}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(mediaRoot, { recursive: true });
cpSync(src, dest, { recursive: true });
copyFileSync(manifestPath, join(mediaRoot, "asset-manifest.json"));
console.log(`[copy-media] ${src} -> ${dest}`);
console.log(`[copy-media] entry manifest -> ${join(mediaRoot, "asset-manifest.json")}`);
