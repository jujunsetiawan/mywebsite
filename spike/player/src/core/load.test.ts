// THROWAWAY — Story 0.4 spike player tests. Not production code; delete after Epic 0.
import { describe, expect, it } from "vitest";
import { LoadError, loadFrameData, loadManifest, type FetchLike } from "./load.ts";

const manifest = {
  schemaVersion: 1,
  mediaVersion: "spike-2026-11-21",
  shots: [
    {
      id: "ii-03-clock",
      act: "II",
      frameCount: 2,
      authoringFps: 24,
      chunkSize: 16,
      chunkCount: 1,
      urlPattern: "<media-base>/<mediaVersion>/<shot-id>/<aspect>/<tier>/chunk-NNNN.bin",
      aspects: [
        { aspect: "16x9", frameCount: 2, tiers: [{ tier: "720", width: 1280, height: 720, totalBytes: 10, chunkBytes: [10] }] },
        { aspect: "9x16", frameCount: 2, tiers: [{ tier: "720", width: 720, height: 1280, totalBytes: 10, chunkBytes: [10] }] },
      ],
    },
  ],
};
type Shot = (typeof manifest.shots)[number];
const withShot = (patch: (s: Record<string, unknown>) => void) => {
  const s = structuredClone(manifest.shots[0]!) as unknown as Record<string, unknown>;
  patch(s);
  return { ...manifest, shots: [s as unknown as Shot] };
};
const frameData = {
  schemaVersion: 1,
  mediaVersion: "spike-2026-11-21",
  act: "II",
  aspect: "16x9",
  shots: [{ id: "ii-03-clock", frameCount: 2, frames: [{ index: 0, quad: null, slices: [] }, { index: 1, quad: null, slices: [] }] }],
};

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    if (!(url in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[url] };
  };
}

describe("matrix: missing manifest", () => {
  it("404 becomes a readable LoadError (no crash)", async () => {
    const err = await loadManifest(fakeFetch({}), "./media").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as Error).message).toMatch(/asset manifest.*HTTP 404/);
  });

  it("network failure becomes a LoadError", async () => {
    const err = await loadManifest(async () => { throw new TypeError("Failed to fetch"); }, "./media").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoadError);
  });

  it("non-v1 manifest is rejected", async () => {
    await expect(loadManifest(fakeFetch({ "./media/asset-manifest.json": { schemaVersion: 2 } }), "./media")).rejects.toThrow(LoadError);
  });
});

describe("matrix: start — manifest then frame data, nothing else", () => {
  it("loads the manifest entry point and frames/<act>.<aspect>.json only", async () => {
    const calls: string[] = [];
    const f = fakeFetch(
      { "./media/asset-manifest.json": manifest, "./media/spike-2026-11-21/frames/II.16x9.json": frameData },
      calls,
    );
    const { manifest: m, shot } = await loadManifest(f, "./media");
    const fd = await loadFrameData(f, "./media", m, shot, "16x9");
    expect(fd.frames.length).toBe(2);
    expect(calls).toEqual(["./media/asset-manifest.json", "./media/spike-2026-11-21/frames/II.16x9.json"]);
  });

  it("frame data for the wrong aspect is rejected", async () => {
    const f = fakeFetch({ "./media/asset-manifest.json": manifest, "./media/spike-2026-11-21/frames/II.9x16.json": frameData });
    const { manifest: m, shot } = await loadManifest(f, "./media");
    await expect(loadFrameData(f, "./media", m, shot, "9x16")).rejects.toThrow(/does not match/);
  });

  it("frame data for the right aspect with the wrong number of frames is rejected", async () => {
    const short = structuredClone(frameData);
    short.shots[0]!.frames.pop();
    const f = fakeFetch({ "./media/asset-manifest.json": manifest, "./media/spike-2026-11-21/frames/II.16x9.json": short });
    const { manifest: m, shot } = await loadManifest(f, "./media");
    await expect(loadFrameData(f, "./media", m, shot, "16x9")).rejects.toThrow(/has 1 frames, manifest says 2/);
  });

  it("frames without a slices array are rejected", async () => {
    const broken = structuredClone(frameData) as unknown as { shots: { frames: Record<string, unknown>[] }[] };
    delete broken.shots[0]!.frames[1]!.slices;
    const f = fakeFetch({ "./media/asset-manifest.json": manifest, "./media/spike-2026-11-21/frames/II.16x9.json": broken });
    const { manifest: m, shot } = await loadManifest(f, "./media");
    await expect(loadFrameData(f, "./media", m, shot, "16x9")).rejects.toThrow(/frame 1 has no slices/);
  });
});

describe("manifest fields the player uses are validated", () => {
  const cases: [string, (s: Record<string, unknown>) => void, RegExp][] = [
    ["missing urlPattern", (s) => delete s.urlPattern, /missing urlPattern/],
    ["urlPattern with an unknown token", (s) => (s.urlPattern = "<media-base>/<act>/chunk-NNNN.bin"), /invalid urlPattern.*<act>/],
    ["urlPattern without NNNN", (s) => (s.urlPattern = "<media-base>/chunk.bin"), /invalid urlPattern/],
    ["chunkSize 0", (s) => (s.chunkSize = 0), /chunkSize must be a positive integer/],
    ["missing frameCount", (s) => delete s.frameCount, /frameCount must be a positive integer/],
    ["aspects missing", (s) => delete s.aspects, /aspects must be a non-empty array/],
    ["aspects empty", (s) => (s.aspects = []), /aspects must be a non-empty array/],
    ["unknown aspect", (s) => ((s.aspects as Record<string, unknown>[])[0]!.aspect = "4x3"), /aspect "4x3"/],
    ["empty tiers", (s) => ((s.aspects as Record<string, unknown>[])[1]!.tiers = []), /9x16 has no tiers/],
    ["bad tier size", (s) => (((s.aspects as Record<string, unknown>[])[0]!.tiers as Record<string, unknown>[])[0]!.width = 0), /width\/height/],
  ];
  for (const [name, patch, msg] of cases) {
    it(`rejects ${name} with a readable LoadError`, async () => {
      const f = fakeFetch({ "./media/asset-manifest.json": withShot(patch) });
      const err = await loadManifest(f, "./media").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LoadError);
      expect((err as Error).message).toMatch(msg);
    });
  }

  it("rejects an empty shots list", async () => {
    await expect(loadManifest(fakeFetch({ "./media/asset-manifest.json": { ...manifest, shots: [] } }), "./media")).rejects.toThrow(/no shots/);
  });
});
