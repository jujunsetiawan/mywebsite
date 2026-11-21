// THROWAWAY — Story 0.4 spike player tests. Not production code; delete after Epic 0.
import { describe, expect, it } from "vitest";
import { parseTierOverride, selectAspect, selectTier, type Tier } from "./variant.ts";

const T169: Tier[] = ["1080", "720"];
const T916: Tier[] = ["720"];

describe("aspect selection (matrix: rotate)", () => {
  it("height > width => 9x16, else 16x9", () => {
    expect(selectAspect(1440, 900)).toBe("16x9");
    expect(selectAspect(390, 844)).toBe("9x16");
    expect(selectAspect(800, 800)).toBe("16x9");
  });

  it("landscape -> portrait switches variant", () => {
    const before = selectAspect(844, 390);
    const after = selectAspect(390, 844);
    expect([before, after]).toEqual(["16x9", "9x16"]);
  });
});

describe("tier selection", () => {
  it("9x16 is always 720", () => {
    expect(selectTier("9x16", 390, 3, T916)).toBe("720");
    expect(selectTier("9x16", 1200, 2, T916, "1080")).toBe("720"); // override not offered
  });

  it("16x9 uses 1080 only when stage width x DPR > 1280", () => {
    expect(selectTier("16x9", 1440, 1, T169)).toBe("1080");
    expect(selectTier("16x9", 1280, 1, T169)).toBe("720");
    expect(selectTier("16x9", 844, 2, T169)).toBe("1080");
    expect(selectTier("16x9", 640, 2, T169)).toBe("720");
  });

  it("?tier= overrides where the variant offers it", () => {
    expect(selectTier("16x9", 1440, 1, T169, "720")).toBe("720");
    expect(selectTier("16x9", 640, 1, T169, "1080")).toBe("1080");
  });

  it("falls back to an available tier", () => {
    expect(selectTier("16x9", 1440, 1, ["720"])).toBe("720");
    expect(() => selectTier("16x9", 1440, 1, [])).toThrow();
  });

  it("parses the override param", () => {
    expect(parseTierOverride("1080")).toBe("1080");
    expect(parseTierOverride("720")).toBe("720");
    expect(parseTierOverride("540")).toBeNull();
    expect(parseTierOverride(null)).toBeNull();
  });
});
