// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// One frame-space -> stage-pixel transform (cover-crop). Used for both the
// canvas draw rectangle and the DOM monitor-quad outline.
//
// Frame space: normalized top-left [0,1] x [0,1] over the whole source frame.
// Stage space: CSS pixels of the stage element (multiply by DPR for canvas pixels).

export type Point = readonly [number, number];
export type Quad = readonly [Point, Point, Point, Point] | null;

export interface FrameToStage {
  /** Stage px per normalized frame unit (x / y). */
  sx: number;
  sy: number;
  /** Stage px offset of frame-space origin (may be negative when cropped). */
  ox: number;
  oy: number;
}

/** Cover-crop: scale the source uniformly so it fills the stage, centred. */
export function coverTransform(srcW: number, srcH: number, stageW: number, stageH: number): FrameToStage {
  if (srcW <= 0 || srcH <= 0) throw new RangeError("source size must be positive");
  const scale = Math.max(stageW / srcW, stageH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { sx: w, sy: h, ox: (stageW - w) / 2, oy: (stageH - h) / 2 };
}

export function mapPoint(t: FrameToStage, p: Point): [number, number] {
  return [t.ox + p[0] * t.sx, t.oy + p[1] * t.sy];
}

/** Canvas destination rectangle in device pixels: [x, y, w, h]. */
export function drawRect(t: FrameToStage, dpr: number): [number, number, number, number] {
  return [t.ox * dpr, t.oy * dpr, t.sx * dpr, t.sy * dpr];
}

/** Quad corners in stage px, or null when the quad is null (outline hidden). */
export function quadToStage(t: FrameToStage, quad: Quad): [number, number][] | null {
  if (!quad) return null;
  return quad.map((p) => mapPoint(t, p));
}

export type QuadVisibility = "hidden" | "inside" | "clipped" | "outside";

/**
 * How the outline relates to the stage: `hidden` for a null quad, `inside`
 * when every corner is on the stage, `outside` when its bounding box misses
 * the stage entirely, otherwise `clipped` (stage overflow clips the outline).
 */
export function quadVisibility(stagePts: readonly (readonly [number, number])[] | null, stageW: number, stageH: number): QuadVisibility {
  if (!stagePts) return "hidden";
  const xs = stagePts.map((p) => p[0]);
  const ys = stagePts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minX >= 0 && maxX <= stageW && minY >= 0 && maxY <= stageH) return "inside";
  if (maxX < 0 || minX > stageW || maxY < 0 || minY > stageH) return "outside";
  return "clipped";
}
