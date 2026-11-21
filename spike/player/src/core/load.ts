// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Manifest + frame-data loading with readable errors (no crash on 404).
// Types come from the v1 contract; the Zod schema itself is not bundled —
// only light sanity checks run here (the pipeline validates with Zod).

import type { FrameData, FrameDataShot, Manifest, ManifestShot } from "../../../manifest/manifest-schema.ts";
import { buildChunkUrl, frameDataUrl, manifestUrl } from "./url.ts";
import type { Aspect } from "./variant.ts";

export type { FrameData, FrameDataShot, Manifest, ManifestShot };

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; statusText?: string; json(): Promise<unknown> }>;

export class LoadError extends Error {}

async function getJson(fetchFn: FetchLike, url: string, what: string): Promise<unknown> {
  let res;
  try {
    res = await fetchFn(url);
  } catch (e) {
    throw new LoadError(`Could not load ${what} (${url}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const hint = res.status === 404 ? " — run `npm run copy-media` first?" : "";
    throw new LoadError(`Could not load ${what} (${url}): HTTP ${res.status}${hint}`);
  }
  try {
    return await res.json();
  } catch {
    throw new LoadError(`${what} (${url}) is not valid JSON`);
  }
}

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const ASPECT_VALUES = ["16x9", "9x16"];
const TIER_VALUES = ["1080", "720"];

/** Check the shot fields the player relies on; throws a readable LoadError. */
export function checkShot(raw: unknown): ManifestShot {
  const s = raw as Record<string, unknown> | null;
  const bad = (what: string) => new LoadError(`asset manifest shot ${JSON.stringify(s?.id ?? "?")}: ${what}`);
  if (!s || typeof s !== "object") throw new LoadError("asset manifest shot is not an object");
  if (!isNonEmptyString(s.id)) throw bad("missing id");
  if (!isNonEmptyString(s.act)) throw bad("missing act");
  if (!isPosInt(s.frameCount)) throw bad(`frameCount must be a positive integer (got ${JSON.stringify(s.frameCount)})`);
  if (!isPosInt(s.chunkSize)) throw bad(`chunkSize must be a positive integer (got ${JSON.stringify(s.chunkSize)})`);
  if (!isNonEmptyString(s.urlPattern)) throw bad("missing urlPattern");
  try {
    buildChunkUrl(s.urlPattern, { mediaBase: ".", mediaVersion: "v", shotId: s.id, aspect: "16x9", tier: "720", chunk: 0 });
  } catch (e) {
    throw bad(`invalid urlPattern: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(s.aspects) || s.aspects.length === 0) throw bad("aspects must be a non-empty array");
  for (const v of s.aspects as Record<string, unknown>[]) {
    if (!v || !ASPECT_VALUES.includes(v.aspect as string)) throw bad(`aspect ${JSON.stringify(v?.aspect)} not in 16x9 | 9x16`);
    if (!Array.isArray(v.tiers) || v.tiers.length === 0) throw bad(`aspect ${String(v.aspect)} has no tiers`);
    for (const t of v.tiers as Record<string, unknown>[]) {
      if (!t || !TIER_VALUES.includes(t.tier as string)) throw bad(`aspect ${String(v.aspect)}: tier ${JSON.stringify(t?.tier)} not in 1080 | 720`);
      if (!isPosInt(t.width) || !isPosInt(t.height)) throw bad(`${String(v.aspect)}/${String(t.tier)}: width/height must be positive integers`);
    }
  }
  return s as unknown as ManifestShot;
}

export async function loadManifest(fetchFn: FetchLike, mediaBase: string): Promise<{ manifest: Manifest; shot: ManifestShot }> {
  const json = (await getJson(fetchFn, manifestUrl(mediaBase), "asset manifest")) as Partial<Manifest> | null;
  if (!json || json.schemaVersion !== 1 || typeof json.mediaVersion !== "string" || !Array.isArray(json.shots)) {
    throw new LoadError("asset manifest is not a v1 manifest (schemaVersion 1, mediaVersion, shots[])");
  }
  if (json.shots.length === 0) throw new LoadError("asset manifest lists no shots");
  const shot = checkShot(json.shots[0]);
  return { manifest: json as Manifest, shot };
}

export async function loadFrameData(
  fetchFn: FetchLike,
  mediaBase: string,
  manifest: Manifest,
  shot: ManifestShot,
  aspect: Aspect,
): Promise<FrameDataShot> {
  const url = frameDataUrl(mediaBase, manifest.mediaVersion, shot.act, aspect);
  const json = (await getJson(fetchFn, url, `frame data ${shot.act}.${aspect}`)) as Partial<FrameData> | null;
  const fd = json?.shots?.find((s) => s.id === shot.id);
  if (!json || json.mediaVersion !== manifest.mediaVersion || json.aspect !== aspect || !fd) {
    throw new LoadError(`frame data ${url} does not match manifest ${manifest.mediaVersion} / shot ${shot.id} / ${aspect}`);
  }
  if (!Array.isArray(fd.frames) || fd.frames.length !== shot.frameCount) {
    throw new LoadError(`frame data ${url} has ${Array.isArray(fd.frames) ? fd.frames.length : "no"} frames, manifest says ${shot.frameCount}`);
  }
  const broken = fd.frames.findIndex((f) => !f || !Array.isArray(f.slices));
  if (broken !== -1) throw new LoadError(`frame data ${url}: frame ${broken} has no slices array`);
  return fd;
}
