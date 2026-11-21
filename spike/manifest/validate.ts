// Local validator for an asset manifest and its frame data (no CI).
//
//   npm --prefix spike run validate -- pipeline/out/spike-2026-11-21/asset-manifest.json
//
// Relative paths resolve against the directory npm was started from
// (INIT_CWD), so the command works from the repository root with --prefix.
// Reads <dir>/asset-manifest.json and every <dir>/frames/*.json.
// Exit codes: 0 valid, 1 invalid, 2 usage or unreadable file.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { formatIssues, validateBundle, type BundleResult } from "./manifest-schema.ts";

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

export class InputError extends Error {}

function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new InputError(`cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new InputError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Load a manifest and all `frames/*.json` next to it, then validate the bundle. */
export function validateManifestFile(manifestPath: string): BundleResult {
  const resolved = path.resolve(manifestPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new InputError(`manifest not found: ${resolved}`);
  }
  const dir = path.dirname(resolved);
  const manifest = readJson(resolved);
  const frameFiles: Record<string, unknown> = {};
  const framesDir = path.join(dir, "frames");
  if (existsSync(framesDir)) {
    for (const name of readdirSync(framesDir).sort()) {
      if (name.endsWith(".json")) frameFiles[`frames/${name}`] = readJson(path.join(framesDir, name));
    }
  }
  return validateBundle(manifest, frameFiles);
}

function summary(result: BundleResult): string {
  const m = result.manifest!;
  const shots = m.shots.map((s) => {
    const variants = s.aspects
      .map((a) => `${a.aspect} [${a.tiers.map((t) => `${t.tier}: ${t.totalBytes} B`).join(", ")}]`)
      .join("; ");
    return `  ${s.id} (act ${s.act}): ${s.frameCount} frames @ ${s.authoringFps} fps, N=${s.chunkSize}, ${s.chunkCount} chunks; ${variants}`;
  });
  return [
    `schemaVersion ${m.schemaVersion}, mediaVersion ${m.mediaVersion}, ${m.shots.length} shot(s)`,
    ...shots,
    `  frame data: ${Object.keys(result.frameData ?? {}).join(", ")}`,
  ].join("\n");
}

export function main(argv: readonly string[]): number {
  const args = argv.filter((a) => a !== "--");
  if (args.length !== 1 || args[0] === "-h" || args[0] === "--help") {
    console.error("usage: npm run validate -- <path/to/asset-manifest.json>");
    return EXIT_USAGE;
  }
  const base = process.env.INIT_CWD ?? process.cwd();
  const target = path.resolve(base, args[0]!);
  let result: BundleResult;
  try {
    result = validateManifestFile(target);
  } catch (err) {
    if (err instanceof InputError) {
      console.error(`ERROR: ${err.message}`);
      return EXIT_USAGE;
    }
    throw err;
  }
  if (!result.ok) {
    console.error(`INVALID: ${target} (${result.issues.length} issue(s))\n${formatIssues(result.issues)}`);
    return EXIT_INVALID;
  }
  console.log(`OK: ${target}\n${summary(result)}`);
  return EXIT_OK;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
