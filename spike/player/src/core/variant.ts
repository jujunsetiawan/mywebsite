// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Aspect variant and tier selection. Pure functions.

export type Aspect = "16x9" | "9x16";
export type Tier = "1080" | "720";

/** Stage height > width => 9x16, else 16x9. */
export function selectAspect(stageWidth: number, stageHeight: number): Aspect {
  return stageHeight > stageWidth ? "9x16" : "16x9";
}

/** Parse `?tier=1080|720`; anything else => null (no override). */
export function parseTierOverride(value: string | null | undefined): Tier | null {
  return value === "1080" || value === "720" ? value : null;
}

/**
 * Tier for a variant:
 * - 9x16 always 720;
 * - 16x9: 1080 when stage width x DPR > 1280, else 720;
 * - an override wins only when the variant offers that tier;
 * - the result is always one of `available` (falls back to its first entry).
 */
export function selectTier(
  aspect: Aspect,
  stageWidth: number,
  dpr: number,
  available: readonly Tier[],
  override: Tier | null = null,
): Tier {
  if (available.length === 0) throw new Error(`variant ${aspect} offers no tiers`);
  if (override && available.includes(override)) return override;
  const wanted: Tier = aspect === "9x16" ? "720" : stageWidth * dpr > 1280 ? "1080" : "720";
  return available.includes(wanted) ? wanted : available[0]!;
}
