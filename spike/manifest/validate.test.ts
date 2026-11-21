// npm test: fixtures — valid passes, each invalid case fails with a readable message.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { chunkUrl, formatIssues, validateBundle } from "./manifest-schema.ts";
import { validateManifestFile } from "./validate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, "fixtures", name, "asset-manifest.json");

function messages(name: string): string {
  const result = validateManifestFile(fixture(name));
  assert.equal(result.ok, false, `${name} should be rejected`);
  return formatIssues(result.issues);
}

function loadValid() {
  const dir = path.join(here, "fixtures", "valid");
  const read = (rel: string) => JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
  return {
    manifest: read("asset-manifest.json"),
    frames: { "frames/II.16x9.json": read("frames/II.16x9.json"), "frames/II.9x16.json": read("frames/II.9x16.json") },
  };
}

test("valid fixture passes", () => {
  const result = validateManifestFile(fixture("valid"));
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.equal(result.manifest?.shots[0]?.chunkCount, 3); // 5 frames, N=2: last chunk partial
});

test("unequal frame counts across aspects are rejected naming both counts", () => {
  const text = messages("invalid-unequal-frame-counts");
  assert.match(text, /unequal frame counts/);
  assert.match(text, /16x9 has 5/);
  assert.match(text, /9x16 has 4/);
});

test("out-of-union tier is rejected naming the value and the union", () => {
  const text = messages("invalid-bad-segment");
  assert.match(text, /tier "540" not in allowed union 1080 \| 720/);
});

test("out-of-union aspect is rejected naming the value and the union", () => {
  const { manifest, frames } = loadValid();
  manifest.shots[0].aspects[1].aspect = "4x3";
  const result = validateBundle(manifest, frames);
  assert.equal(result.ok, false);
  assert.match(formatIssues(result.issues), /aspect "4x3" not in allowed union 16x9 \| 9x16/);
});

test("offset outside its chunk is rejected naming frame and chunk", () => {
  const text = messages("invalid-offset-outside-chunk");
  assert.match(text, /frame 4 tier 1080: offset 100 \+ length 1400 = 1500 lies outside chunk 2 \(1400 bytes\)/);
});

test("9x16 at tier 1080 is rejected (9:16 has 720 only)", () => {
  const text = messages("invalid-9x16-1080");
  assert.match(text, /tier 1080 not allowed for aspect 9x16 \(allowed: 720\)/);
});

test("unreferenced bytes inside a chunk are rejected", () => {
  const text = messages("invalid-chunk-gap");
  assert.match(text, /16x9 tier 1080 chunk 0: gap of 10 unreferenced byte\(s\) at offset 1000 before frame 1/);
});

test("trailing unreferenced bytes in a chunk are rejected", () => {
  const { manifest, frames } = loadValid();
  const t = manifest.shots[0].aspects[0].tiers[0];
  t.chunkBytes[2] += 5;
  t.totalBytes += 5;
  const result = validateBundle(manifest, frames);
  assert.equal(result.ok, false);
  assert.match(formatIssues(result.issues), /chunk 2: bytes 1400\.\.1405 \(5\) not referenced by any frame/);
});

test("missing frame data file is rejected", () => {
  const { manifest, frames } = loadValid();
  const result = validateBundle(manifest, { "frames/II.16x9.json": frames["frames/II.16x9.json"] });
  assert.equal(result.ok, false);
  assert.match(formatIssues(result.issues), /frame data file frames\/II\.9x16\.json missing/);
});

test("quad with wrong corner order is rejected", () => {
  const { manifest, frames } = loadValid();
  const q = frames["frames/II.16x9.json"].shots[0].frames[0].quad;
  frames["frames/II.16x9.json"].shots[0].frames[0].quad = [q[0], q[3], q[2], q[1]]; // counter-clockwise
  const result = validateBundle(manifest, frames);
  assert.equal(result.ok, false);
  assert.match(formatIssues(result.issues), /TL, TR, BR, BL/);
});

test("chunkUrl expands the URL pattern with a 4-digit pad", () => {
  assert.equal(
    chunkUrl("https://media.example/", "spike-2026-11-21", "ii-03-clock", "9x16", "720", 4),
    "https://media.example/spike-2026-11-21/ii-03-clock/9x16/720/chunk-0004.bin",
  );
});

test("CLI exits 0 for valid and 1 for invalid", () => {
  const cli = path.join(here, "validate.ts");
  const run = (name: string) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, fixture(name)], { encoding: "utf8", env: { ...process.env, INIT_CWD: here } });
  const ok = run("valid");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^OK: /);
  const bad = run("invalid-offset-outside-chunk");
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /INVALID: .*lies outside chunk 2/s);
});
