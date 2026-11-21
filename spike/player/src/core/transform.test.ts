// THROWAWAY — Story 0.4 spike player tests. Not production code; delete after Epic 0.
import { describe, expect, it } from "vitest";
import { coverTransform, drawRect, mapPoint, quadToStage, quadVisibility, type Quad } from "./transform.ts";

describe("cover-crop transform", () => {
  it("exact aspect fills the stage", () => {
    const t = coverTransform(1920, 1080, 1440, 810);
    expect(t).toEqual({ sx: 1440, sy: 810, ox: 0, oy: 0 });
  });

  it("taller stage crops left/right, centred", () => {
    const t = coverTransform(1920, 1080, 1440, 900); // scale = 900/1080
    expect(t.sy).toBeCloseTo(900);
    expect(t.sx).toBeCloseTo(1600);
    expect(t.ox).toBeCloseTo(-80);
    expect(t.oy).toBeCloseTo(0);
  });

  it("wider stage crops top/bottom (9x16 source on 390x844)", () => {
    const t = coverTransform(720, 1280, 390, 844); // scale = max(0.5417, 0.6594)
    expect(t.sy).toBeCloseTo(844);
    expect(t.sx).toBeCloseTo(474.75);
    expect(t.ox).toBeCloseTo(-42.375);
  });

  it("canvas rect is the same transform at DPR", () => {
    const t = coverTransform(1920, 1080, 1440, 900);
    expect(drawRect(t, 2)).toEqual([t.ox * 2, t.oy * 2, t.sx * 2, t.sy * 2]);
  });

  it("frame centre maps to stage centre", () => {
    const t = coverTransform(720, 1280, 390, 844);
    const [x, y] = mapPoint(t, [0.5, 0.5]);
    expect(x).toBeCloseTo(195);
    expect(y).toBeCloseTo(422);
  });
});

describe("matrix: quad null / off-frame", () => {
  const t = coverTransform(1920, 1080, 1440, 810);

  it("null quad => hidden outline", () => {
    expect(quadToStage(t, null)).toBeNull();
    expect(quadVisibility(null, 1440, 810)).toBe("hidden");
  });

  it("quad inside [0,1] maps through the transform and is fully visible", () => {
    const q: Quad = [[0.2, 0.3], [0.8, 0.3], [0.8, 0.6], [0.2, 0.6]];
    const pts = quadToStage(t, q)!;
    expect(pts[0]![0]).toBeCloseTo(288);
    expect(pts[0]![1]).toBeCloseTo(243);
    expect(pts[2]![0]).toBeCloseTo(1152);
    expect(pts[2]![1]).toBeCloseTo(486);
    expect(quadVisibility(pts, 1440, 810)).toBe("inside");
  });

  it("quad partly outside [0,1] keeps its true coordinates (stage clips the outline)", () => {
    // Frame 71 of 9x16: runs off the bottom and both sides.
    const q: Quad = [[-0.071563, 0.862275], [1.084212, 0.86749], [1.142652, 1.306857], [-0.125252, 1.274363]];
    const pts = quadToStage(t, q)!;
    expect(pts[3]![0]).toBeLessThan(0);
    expect(pts[2]![1]).toBeGreaterThan(810);
    expect(quadVisibility(pts, 1440, 810)).toBe("clipped");
  });

  it("quad entirely off-frame is reported outside", () => {
    const q: Quad = [[0.2, 1.2], [0.8, 1.2], [0.8, 1.5], [0.2, 1.5]];
    expect(quadVisibility(quadToStage(t, q), 1440, 810)).toBe("outside");
  });

  it("cover-crop pushes an in-frame edge quad off the stage => clipped", () => {
    const crop = coverTransform(1920, 1080, 390, 844); // heavy side crop
    const q: Quad = [[0.05, 0.4], [0.3, 0.4], [0.3, 0.6], [0.05, 0.6]];
    expect(quadVisibility(quadToStage(crop, q), 390, 844)).not.toBe("inside");
  });
});
