// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Media URLs built only from the manifest's urlPattern:
//   <media-base>/<mediaVersion>/<shot-id>/<aspect>/<tier>/chunk-NNNN.bin

export interface ChunkUrlParts {
  mediaBase: string;
  mediaVersion: string;
  shotId: string;
  aspect: string;
  tier: string;
  chunk: number;
}

const TOKENS: Record<string, (p: ChunkUrlParts) => string> = {
  "<media-base>": (p) => p.mediaBase.replace(/\/+$/, ""),
  "<mediaVersion>": (p) => p.mediaVersion,
  "<shot-id>": (p) => p.shotId,
  "<aspect>": (p) => p.aspect,
  "<tier>": (p) => p.tier,
};

/** Expand a manifest urlPattern for one chunk. Throws on unknown tokens or a bad chunk index. */
export function buildChunkUrl(pattern: string, parts: ChunkUrlParts): string {
  if (!Number.isInteger(parts.chunk) || parts.chunk < 0 || parts.chunk > 9999) {
    throw new RangeError(`chunk index must be 0..9999, got ${parts.chunk}`);
  }
  let url = pattern;
  for (const [token, value] of Object.entries(TOKENS)) {
    url = url.split(token).join(value(parts));
  }
  if (!url.includes("NNNN")) throw new Error(`urlPattern has no NNNN chunk placeholder: ${pattern}`);
  url = url.replace("NNNN", String(parts.chunk).padStart(4, "0"));
  const leftover = url.match(/<[^>]+>/);
  if (leftover) throw new Error(`urlPattern has unknown token ${leftover[0]}: ${pattern}`);
  return url;
}

/** `<media-base>/<mediaVersion>/frames/<act>.<aspect>.json` */
export function frameDataUrl(mediaBase: string, mediaVersion: string, act: string, aspect: string): string {
  return `${mediaBase.replace(/\/+$/, "")}/${mediaVersion}/frames/${act}.${aspect}.json`;
}

/** Entry point: `<media-base>/asset-manifest.json` (copy of the mediaVersion's manifest). */
export function manifestUrl(mediaBase: string): string {
  return `${mediaBase.replace(/\/+$/, "")}/asset-manifest.json`;
}
