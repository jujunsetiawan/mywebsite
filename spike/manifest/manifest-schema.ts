// REUSABLE — v1 contract, to be moved to `src/film/core/manifest-types.ts`
//
// Asset manifest v1 (pipeline -> player contract), Zod 4.
//
// Two documents under one mediaVersion directory:
//
//   <mediaVersion>/asset-manifest.json      -> ManifestSchema
//   <mediaVersion>/frames/<act>.<aspect>.json -> FrameDataSchema
//
// Each document is validated on its own; `validateBundle` adds the cross-file
// rules (frame counts per aspect, slice offsets inside their chunk, tiers
// listed in the manifest). Chunk URLs are built only from the manifest:
//
//   <media-base>/<mediaVersion>/<shot-id>/<aspect>/<tier>/chunk-NNNN.bin
//
// Spike unions: aspect `16x9 | 9x16`, tier `1080 | 720` (full union later:
// `1080 | 720 | 540 | still | lite-layers`). Published media under a
// mediaVersion is immutable; a content change needs a new mediaVersion.

import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
export const ASPECTS = ["16x9", "9x16"] as const;
export const TIERS = ["1080", "720"] as const;
export const URL_PATTERN = "<media-base>/<mediaVersion>/<shot-id>/<aspect>/<tier>/chunk-NNNN.bin" as const;
export const FRAME_DATA_PATTERN = "frames/<act>.<aspect>.json" as const;

export type Aspect = (typeof ASPECTS)[number];
export type Tier = (typeof TIERS)[number];

/** Tiers allowed per aspect in the spike: 9:16 has no 1080 (architecture AD-14 / spec). */
export const TIERS_BY_ASPECT: Record<Aspect, readonly Tier[]> = {
  "16x9": ["1080", "720"],
  "9x16": ["720"],
};

/** Pixel size of every (aspect, tier) the v1 contract knows. */
export const TIER_SIZES: Record<Aspect, Record<Tier, readonly [number, number]>> = {
  "16x9": { "1080": [1920, 1080], "720": [1280, 720] },
  "9x16": { "1080": [1080, 1920], "720": [720, 1280] },
};

// ------------------------------------------------------------------ Atoms

function unionError(what: string, allowed: readonly string[]) {
  return (issue: { input?: unknown }) =>
    issue.input === undefined
      ? `${what} is required (allowed union: ${allowed.join(" | ")})`
      : `${what} ${JSON.stringify(issue.input)} not in allowed union ${allowed.join(" | ")}`;
}

export const AspectSchema = z.enum(ASPECTS, { error: unionError("aspect", ASPECTS) });
export const TierSchema = z.enum(TIERS, { error: unionError("tier", TIERS) });

const posInt = z.number().int().positive();
const nonNegInt = z.number().int().nonnegative();

export const MediaVersionSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]*$/, "mediaVersion must be lowercase [a-z0-9.-], e.g. spike-2026-11-21");
export const ShotIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "shot id must be kebab-case, e.g. ii-03-clock");
export const ActSchema = z.string().regex(/^[IVX]+$/, "act must be a Roman numeral, e.g. II");

// --------------------------------------------------------------- Manifest

export const TierEntrySchema = z.strictObject({
  tier: TierSchema,
  width: posInt,
  height: posInt,
  /** Sum of chunkBytes: total bytes of this tier for this aspect. */
  totalBytes: posInt,
  /** Byte size of each chunk file, index = chunk number. */
  chunkBytes: z.array(posInt).min(1),
});

export const AspectVariantSchema = z.strictObject({
  aspect: AspectSchema,
  /** Must equal the shot frameCount (identical frame counts in every aspect). */
  frameCount: posInt,
  tiers: z.array(TierEntrySchema).min(1),
});

export const ShotSchema = z
  .strictObject({
    id: ShotIdSchema,
    act: ActSchema,
    frameCount: posInt,
    authoringFps: posInt,
    /** N: frames per chunk file (last chunk may hold fewer). */
    chunkSize: posInt,
    chunkCount: posInt,
    urlPattern: z.literal(URL_PATTERN, {
      error: (iss) => `urlPattern must be exactly "${URL_PATTERN}", got ${JSON.stringify(iss.input)}`,
    }),
    aspects: z.array(AspectVariantSchema).min(1),
  })
  .superRefine((shot, ctx) => {
    const where = `shot "${shot.id}"`;

    const seen = shot.aspects.map((a) => a.aspect);
    for (const aspect of ASPECTS) {
      const n = seen.filter((a) => a === aspect).length;
      if (n !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["aspects"],
          message: `${where}: aspect ${aspect} must appear exactly once (found ${n}); every shot has 16x9 and 9x16 variants`,
        });
      }
    }

    const counts = shot.aspects.map((a) => `${a.aspect} has ${a.frameCount}`);
    if (shot.aspects.some((a) => a.frameCount !== shot.frameCount)) {
      shot.aspects.forEach((a, i) => {
        if (a.frameCount !== shot.frameCount) {
          ctx.addIssue({
            code: "custom",
            path: ["aspects", i, "frameCount"],
            message: `${where}: unequal frame counts across aspects (${counts.join(", ")}; shot frameCount is ${shot.frameCount})`,
          });
        }
      });
    }

    const expectedChunks = Math.ceil(shot.frameCount / shot.chunkSize);
    if (shot.chunkCount !== expectedChunks) {
      ctx.addIssue({
        code: "custom",
        path: ["chunkCount"],
        message: `${where}: chunkCount ${shot.chunkCount} != ceil(frameCount ${shot.frameCount} / chunkSize ${shot.chunkSize}) = ${expectedChunks}`,
      });
    }

    shot.aspects.forEach((variant, ai) => {
      const tiers = variant.tiers.map((t) => t.tier);
      variant.tiers.forEach((t, ti) => {
        const path = ["aspects", ai, "tiers", ti];
        const label = `${where} ${variant.aspect}/${t.tier}`;
        if (tiers.indexOf(t.tier) !== ti) {
          ctx.addIssue({ code: "custom", path, message: `${label}: tier listed twice` });
        }
        const allowed = TIERS_BY_ASPECT[variant.aspect];
        if (!allowed.includes(t.tier)) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "tier"],
            message: `${label}: tier ${t.tier} not allowed for aspect ${variant.aspect} (allowed: ${allowed.join(" | ")})`,
          });
        }
        const [w, h] = TIER_SIZES[variant.aspect][t.tier];
        if (t.width !== w || t.height !== h) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `${label}: size ${t.width}x${t.height}, expected ${w}x${h}`,
          });
        }
        if (t.chunkBytes.length !== shot.chunkCount) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "chunkBytes"],
            message: `${label}: ${t.chunkBytes.length} chunkBytes entries, expected chunkCount ${shot.chunkCount}`,
          });
        }
        const sum = t.chunkBytes.reduce((a, b) => a + b, 0);
        if (sum !== t.totalBytes) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "totalBytes"],
            message: `${label}: totalBytes ${t.totalBytes} != sum of chunkBytes ${sum}`,
          });
        }
      });
    });
  });

export const ManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION, {
      error: (iss) => `schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(iss.input)}`,
    }),
    /** Exactly one mediaVersion per manifest; all URLs are built under it. */
    mediaVersion: MediaVersionSchema,
    shots: z.array(ShotSchema).min(1),
  })
  .superRefine((m, ctx) => {
    const ids = m.shots.map((s) => s.id);
    ids.forEach((id, i) => {
      if (ids.indexOf(id) !== i) {
        ctx.addIssue({ code: "custom", path: ["shots", i, "id"], message: `shot id "${id}" listed twice` });
      }
    });
  });

// ------------------------------------------------------------- Frame data

const coord = z.number().refine(Number.isFinite, "quad coordinate must be a finite number");
export const PointSchema = z.tuple([coord, coord]);

/**
 * Monitor screen quad: normalized top-left [0,1] frame coordinates (values may
 * fall outside [0,1] while the screen is partly off-frame), corners ordered
 * TL, TR, BR, BL (clockwise on screen). `null` when the screen is behind the
 * camera for that frame.
 */
export const QuadSchema = z
  .tuple([PointSchema, PointSchema, PointSchema, PointSchema])
  .refine((q) => signedAreaTopLeft(q) > 0, "quad corners must be ordered TL, TR, BR, BL (clockwise on screen)")
  .nullable();

export const FrameSliceSchema = z.strictObject({
  tier: TierSchema,
  /** Chunk file index: floor(frame index / chunkSize). */
  chunk: nonNegInt,
  /** Byte offset of this frame's AVIF inside the chunk file. */
  offset: nonNegInt,
  /** Byte length of this frame's AVIF. */
  length: posInt,
});

export const FrameSchema = z.strictObject({
  /** 0-based frame index within the shot (equals the array position). */
  index: nonNegInt,
  quad: QuadSchema,
  slices: z.array(FrameSliceSchema).min(1),
});

export const FrameDataShotSchema = z
  .strictObject({
    id: ShotIdSchema,
    frameCount: posInt,
    frames: z.array(FrameSchema),
  })
  .superRefine((s, ctx) => {
    if (s.frames.length !== s.frameCount) {
      ctx.addIssue({
        code: "custom",
        path: ["frames"],
        message: `shot "${s.id}": ${s.frames.length} frame entries but frameCount ${s.frameCount}`,
      });
    }
    s.frames.forEach((f, i) => {
      if (f.index !== i) {
        ctx.addIssue({
          code: "custom",
          path: ["frames", i, "index"],
          message: `shot "${s.id}": frame at position ${i} has index ${f.index} (frames are 0-based and in order)`,
        });
      }
      const tiers = f.slices.map((sl) => sl.tier);
      tiers.forEach((t, j) => {
        if (tiers.indexOf(t) !== j) {
          ctx.addIssue({
            code: "custom",
            path: ["frames", i, "slices", j],
            message: `shot "${s.id}" frame ${f.index}: tier ${t} sliced twice`,
          });
        }
      });
    });
  });

export const FrameDataSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION, {
      error: (iss) => `schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(iss.input)}`,
    }),
    mediaVersion: MediaVersionSchema,
    act: ActSchema,
    aspect: AspectSchema,
    shots: z.array(FrameDataShotSchema).min(1),
  })
  .superRefine((d, ctx) => {
    const ids = d.shots.map((s) => s.id);
    ids.forEach((id, i) => {
      if (ids.indexOf(id) !== i) {
        ctx.addIssue({ code: "custom", path: ["shots", i, "id"], message: `shot id "${id}" listed twice` });
      }
    });
  });

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestShot = z.infer<typeof ShotSchema>;
export type AspectVariant = z.infer<typeof AspectVariantSchema>;
export type TierEntry = z.infer<typeof TierEntrySchema>;
export type FrameData = z.infer<typeof FrameDataSchema>;
export type FrameDataShot = z.infer<typeof FrameDataShotSchema>;
export type Frame = z.infer<typeof FrameSchema>;
export type FrameSlice = z.infer<typeof FrameSliceSchema>;
export type Quad = z.infer<typeof QuadSchema>;

// ---------------------------------------------------------------- Helpers

/** Shoelace area with y pointing down: positive for TL, TR, BR, BL order. */
export function signedAreaTopLeft(points: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** `frames/<act>.<aspect>.json`, relative to the mediaVersion directory. */
export function frameDataPath(act: string, aspect: Aspect): string {
  return `frames/${act}.${aspect}.json`;
}

/** Expand URL_PATTERN for one chunk (4-digit zero pad). */
export function chunkUrl(
  mediaBase: string,
  mediaVersion: string,
  shotId: string,
  aspect: Aspect,
  tier: Tier,
  chunk: number,
): string {
  if (!Number.isInteger(chunk) || chunk < 0 || chunk > 9999) {
    throw new RangeError(`chunk index must be 0..9999, got ${chunk}`);
  }
  return `${mediaBase.replace(/\/+$/, "")}/${mediaVersion}/${shotId}/${aspect}/${tier}/chunk-${String(chunk).padStart(4, "0")}.bin`;
}

// -------------------------------------------------------- Bundle validation

export interface Issue {
  /** File (relative to the mediaVersion directory) and JSON path, e.g. `frames/II.16x9.json: shots[0].frames[4]`. */
  where: string;
  message: string;
}

export interface BundleResult {
  ok: boolean;
  issues: Issue[];
  manifest?: Manifest;
  frameData?: Record<string, FrameData>;
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const key of path) {
    out += typeof key === "number" ? `[${key}]` : `${out ? "." : ""}${String(key)}`;
  }
  return out || "(root)";
}

function zodIssues(file: string, error: z.ZodError): Issue[] {
  return error.issues.map((iss) => ({ where: `${file}: ${formatPath(iss.path)}`, message: iss.message }));
}

/**
 * Validate a manifest plus its frame data files.
 *
 * `frameFiles` maps paths relative to the mediaVersion directory
 * (`frames/II.16x9.json`) to parsed JSON. Every (act, aspect) the manifest
 * needs must be present. Cross-file rules run only when every document is
 * individually valid, so messages point at the first real problem.
 */
export function validateBundle(manifestJson: unknown, frameFiles: Record<string, unknown>): BundleResult {
  const issues: Issue[] = [];
  const m = ManifestSchema.safeParse(manifestJson);
  if (!m.success) issues.push(...zodIssues("asset-manifest.json", m.error));

  const frameData: Record<string, FrameData> = {};
  for (const [file, json] of Object.entries(frameFiles)) {
    const r = FrameDataSchema.safeParse(json);
    if (r.success) frameData[file] = r.data;
    else issues.push(...zodIssues(file, r.error));
  }
  if (issues.length > 0 || !m.success) return { ok: false, issues };

  const manifest = m.data;
  for (const [file, data] of Object.entries(frameData)) {
    const expected = frameDataPath(data.act, data.aspect);
    if (file !== expected) {
      issues.push({ where: file, message: `act ${data.act} / aspect ${data.aspect} belongs in ${expected}` });
    }
    if (data.mediaVersion !== manifest.mediaVersion) {
      issues.push({
        where: `${file}: mediaVersion`,
        message: `mediaVersion ${data.mediaVersion} != manifest mediaVersion ${manifest.mediaVersion}`,
      });
    }
  }

  manifest.shots.forEach((shot, si) => {
    for (const variant of shot.aspects) {
      const file = frameDataPath(shot.act, variant.aspect);
      const data = frameData[file];
      const label = `shot "${shot.id}" ${variant.aspect}`;
      if (!data) {
        issues.push({ where: `asset-manifest.json: shots[${si}]`, message: `${label}: frame data file ${file} missing` });
        continue;
      }
      const fdi = data.shots.findIndex((s) => s.id === shot.id);
      const fd = data.shots[fdi];
      if (!fd) {
        issues.push({ where: file, message: `${label}: shot missing from frame data` });
        continue;
      }
      const base = `${file}: shots[${fdi}]`;
      if (fd.frameCount !== variant.frameCount) {
        issues.push({
          where: `${base}.frameCount`,
          message: `${label}: frame data has ${fd.frameCount} frames, manifest lists ${variant.frameCount}`,
        });
        continue;
      }

      const tierEntries = new Map(variant.tiers.map((t) => [t.tier, t] as const));
      // tier -> chunk -> slices, for overlap / coverage checks
      const byChunk = new Map<Tier, Map<number, { index: number; offset: number; length: number }[]>>();
      fd.frames.forEach((frame, fi) => {
        const fwhere = `${base}.frames[${fi}]`;
        const sliced = new Set(frame.slices.map((s) => s.tier));
        for (const t of tierEntries.keys()) {
          if (!sliced.has(t)) {
            issues.push({ where: fwhere, message: `${label} frame ${frame.index}: no slice for tier ${t}` });
          }
        }
        frame.slices.forEach((slice, sli) => {
          const swhere = `${fwhere}.slices[${sli}]`;
          const slabel = `${label} frame ${frame.index} tier ${slice.tier}`;
          const entry = tierEntries.get(slice.tier);
          if (!entry) {
            issues.push({ where: swhere, message: `${slabel}: tier not listed in the manifest for ${variant.aspect}` });
            return;
          }
          const expectedChunk = Math.floor(frame.index / shot.chunkSize);
          if (slice.chunk !== expectedChunk) {
            issues.push({
              where: swhere,
              message: `${slabel}: chunk ${slice.chunk}, expected floor(${frame.index} / chunkSize ${shot.chunkSize}) = ${expectedChunk}`,
            });
            return;
          }
          const size = entry.chunkBytes[slice.chunk];
          if (size === undefined) {
            issues.push({ where: swhere, message: `${slabel}: chunk ${slice.chunk} does not exist (chunkCount ${shot.chunkCount})` });
            return;
          }
          const end = slice.offset + slice.length;
          if (end > size) {
            issues.push({
              where: swhere,
              message: `${slabel}: offset ${slice.offset} + length ${slice.length} = ${end} lies outside chunk ${slice.chunk} (${size} bytes)`,
            });
            return;
          }
          let chunks = byChunk.get(slice.tier);
          if (!chunks) byChunk.set(slice.tier, (chunks = new Map()));
          let list = chunks.get(slice.chunk);
          if (!list) chunks.set(slice.chunk, (list = []));
          list.push({ index: frame.index, offset: slice.offset, length: slice.length });
        });
      });

      // Slices must tile each chunk exactly: contiguous from offset 0, no overlap,
      // no gap, ending at chunkBytes (no unreferenced bytes).
      for (const [tier, entry] of tierEntries) {
        const chunks = byChunk.get(tier) ?? new Map<number, { index: number; offset: number; length: number }[]>();
        entry.chunkBytes.forEach((size, chunk) => {
          const list = (chunks.get(chunk) ?? []).sort((a, b) => a.offset - b.offset);
          const clabel = `${label} tier ${tier} chunk ${chunk}`;
          let pos = 0;
          for (const cur of list) {
            if (cur.offset < pos) {
              issues.push({ where: base, message: `${clabel}: frame ${cur.index} at offset ${cur.offset} overlaps the previous frame (ends at ${pos})` });
            } else if (cur.offset > pos) {
              issues.push({ where: base, message: `${clabel}: gap of ${cur.offset - pos} unreferenced byte(s) at offset ${pos} before frame ${cur.index}` });
            }
            pos = Math.max(pos, cur.offset + cur.length);
          }
          if (pos < size) {
            issues.push({ where: base, message: `${clabel}: bytes ${pos}..${size} (${size - pos}) not referenced by any frame` });
          }
        });
      }
    }
  });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues, manifest, frameData };
}

/** One readable line per issue. */
export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((i) => `  - ${i.where}: ${i.message}`).join("\n");
}
