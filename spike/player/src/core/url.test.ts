// THROWAWAY — Story 0.4 spike player tests. Not production code; delete after Epic 0.
import { describe, expect, it } from "vitest";
import { buildChunkUrl, frameDataUrl, manifestUrl } from "./url.ts";

const PATTERN = "<media-base>/<mediaVersion>/<shot-id>/<aspect>/<tier>/chunk-NNNN.bin";
const parts = { mediaBase: "./media", mediaVersion: "spike-2026-11-21", shotId: "ii-03-clock", aspect: "9x16", tier: "720", chunk: 3 };

describe("chunk URL from the manifest pattern", () => {
  it("expands every token with a 4-digit chunk", () => {
    expect(buildChunkUrl(PATTERN, parts)).toBe("./media/spike-2026-11-21/ii-03-clock/9x16/720/chunk-0003.bin");
    expect(buildChunkUrl(PATTERN, { ...parts, chunk: 0, aspect: "16x9", tier: "1080" })).toBe(
      "./media/spike-2026-11-21/ii-03-clock/16x9/1080/chunk-0000.bin",
    );
  });

  it("strips trailing slashes from the media base", () => {
    expect(buildChunkUrl(PATTERN, { ...parts, mediaBase: "https://cdn.example/media//" })).toBe(
      "https://cdn.example/media/spike-2026-11-21/ii-03-clock/9x16/720/chunk-0003.bin",
    );
  });

  it("rejects bad chunk indexes and unknown tokens", () => {
    expect(() => buildChunkUrl(PATTERN, { ...parts, chunk: -1 })).toThrow(RangeError);
    expect(() => buildChunkUrl(PATTERN, { ...parts, chunk: 1.5 })).toThrow(RangeError);
    expect(() => buildChunkUrl(PATTERN, { ...parts, chunk: 10000 })).toThrow(RangeError);
    expect(() => buildChunkUrl("<media-base>/<act>/chunk-NNNN.bin", parts)).toThrow(/unknown token <act>/);
    expect(() => buildChunkUrl("<media-base>/chunk.bin", parts)).toThrow(/NNNN/);
  });
});

describe("frame data + manifest URLs", () => {
  it("builds frames/<act>.<aspect>.json under the mediaVersion", () => {
    expect(frameDataUrl("./media", "spike-2026-11-21", "II", "16x9")).toBe("./media/spike-2026-11-21/frames/II.16x9.json");
    expect(manifestUrl("./media/")).toBe("./media/asset-manifest.json");
  });
});
