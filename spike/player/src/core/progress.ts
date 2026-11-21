// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Scroll position -> progress -> frame index. Pure functions.

/** Spacer height in viewport heights. */
export const SPACER_SCREENS = 6;

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Spacer height derived from the viewport height (CSS px, integer). */
export function spacerHeight(innerHeight: number, screens = SPACER_SCREENS): number {
  return Math.max(1, Math.round(innerHeight * screens));
}

/** progress = scrollY / (spacerHeight - innerHeight), clamped to [0, 1]. */
export function progressFromScroll(scrollY: number, spacer: number, innerHeight: number): number {
  const max = spacer - innerHeight;
  if (max <= 0) return 0;
  return clamp01(scrollY / max);
}

/** Inverse of progressFromScroll (used to keep progress across resize/rotation). */
export function scrollForProgress(progress: number, spacer: number, innerHeight: number): number {
  const max = Math.max(0, spacer - innerHeight);
  return clamp01(progress) * max;
}

/** frame = min(frameCount - 1, floor(progress * frameCount)). Direction-independent. */
export function frameIndexFromProgress(progress: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  return Math.min(frameCount - 1, Math.floor(clamp01(progress) * frameCount));
}

/**
 * Which frame to draw this tick: the target when it is decoded, otherwise
 * `null` = keep the last drawn frame on the canvas (no spinner, no blank).
 */
export function frameToDraw(target: number, isReady: (index: number) => boolean): number | null {
  return isReady(target) ? target : null;
}
