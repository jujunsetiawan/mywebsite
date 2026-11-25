// Film Credit Open Graph images (Story 1.10): content + fonts → 1200×630
// 8-bit RGB PNG bytes. satori lays the markup out as SVG (text as paths),
// @resvg/resvg-js rasterises it, `png.ts` re-encodes without alpha.
// Build-only: imported by the `og-images` integration and tests, never by a
// page or client code.
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import type { Locale } from '../content/schemas.ts';
import type { OgContent, OgProject } from './content.ts';
import { faceKey, SANS, SERIF, type FontStyle, type OgFonts } from './fonts.ts';
import { OG_HEIGHT, OG_WIDTH } from './paths.ts';
import { encodeRgbPng } from './png.ts';
import { fontMeasure, wrapText } from './text.ts';
import type { OgColors } from './tokens.ts';

/** Safe margin on every side, px. */
export const MARGIN = 64;
/** Width available to text, px. */
export const TEXT_WIDTH = OG_WIDTH - 2 * MARGIN;

/** Type scale of the images (px); weight is always 400. */
export const OG_TYPE = {
  caps: { size: 22, letterSpacingEm: 0.32, lineHeight: 1.4, maxLines: 1 },
  siteName: { size: 96, lineHeight: 1.08, maxLines: 2 },
  jobTitle: { size: 40, lineHeight: 1.3, maxLines: 2 },
  projectName: { size: 76, lineHeight: 1.08, maxLines: 2 },
  outcome: { size: 34, lineHeight: 1.3, maxLines: 3 },
  credit: { size: 28, lineHeight: 1.3, maxLines: 1 },
} as const;

/** Rule under the project image's credit line, px. */
const RULE_HEIGHT = 2;

/** A satori element (React-element shape, no React needed). */
export interface OgNode {
  type: 'div';
  props: { style: Record<string, string | number>; children?: OgNode[] | string };
}

const div = (style: Record<string, string | number>, children?: OgNode[] | string): OgNode => ({
  type: 'div',
  props: { style, ...(children === undefined ? {} : { children }) },
});

export interface RenderInput {
  lang: Locale;
  content: OgContent;
  colors: OgColors;
  fonts: OgFonts;
}

interface TextStyle {
  family: string;
  style: FontStyle;
  size: number;
  lineHeight: number;
  maxLines: number;
  color: string;
  letterSpacing?: number;
}

/** Wrapped lines of `text`, one non-wrapping element each. */
function textBlock(fonts: OgFonts, text: string, s: TextStyle): OgNode {
  const metrics = fonts.metrics[faceKey(s.family, s.style)];
  if (metrics === undefined || metrics.length === 0) throw new Error(`no font loaded for ${s.family} ${s.style}`);
  const lines = wrapText(text, {
    maxWidth: TEXT_WIDTH,
    maxLines: s.maxLines,
    measure: fontMeasure(metrics, s.size, s.letterSpacing ?? 0),
  });
  return div(
    { display: 'flex', flexDirection: 'column' },
    lines.map((line) =>
      div(
        {
          fontFamily: s.family,
          fontStyle: s.style,
          fontWeight: 400,
          fontSize: s.size,
          lineHeight: s.lineHeight,
          color: s.color,
          whiteSpace: 'nowrap',
          ...(s.letterSpacing ? { letterSpacing: s.letterSpacing } : {}),
        },
        line,
      ),
    ),
  );
}

function capsLine({ lang, content, colors, fonts }: RenderInput): OgNode {
  const t = OG_TYPE.caps;
  return textBlock(fonts, content.credit[lang].toLocaleUpperCase(lang), {
    family: SANS,
    style: 'normal',
    size: t.size,
    lineHeight: t.lineHeight,
    maxLines: t.maxLines,
    color: colors.muted,
    letterSpacing: t.size * t.letterSpacingEm,
  });
}

function frame(colors: OgColors, children: OgNode[]): OgNode {
  return div(
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      // satori sizes boxes as content-box by default: keep the margin inside the canvas.
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: MARGIN,
      backgroundColor: colors.panel,
    },
    children,
  );
}

/** Element tree of the site image (exported for tests). */
export function siteImageTree(input: RenderInput): OgNode {
  const { lang, content, colors, fonts } = input;
  const caps = capsLine(input);
  const name = textBlock(fonts, content.name, { family: SERIF, style: 'normal', color: colors.primary, ...OG_TYPE.siteName });
  const job = textBlock(fonts, content.jobTitle[lang], { family: SERIF, style: 'italic', color: colors.soft, ...OG_TYPE.jobTitle });
  // An empty bottom spacer as tall as the caps line keeps the name block centred.
  const spacer = div({ height: OG_TYPE.caps.size * OG_TYPE.caps.lineHeight });
  return frame(colors, [caps, div({ display: 'flex', flexDirection: 'column', gap: 20 }, [name, job]), spacer]);
}

/** Element tree of a project image (exported for tests). */
export function projectImageTree(input: RenderInput, project: OgProject): OgNode {
  const { lang, content, colors, fonts } = input;
  const caps = capsLine(input);
  const name = textBlock(fonts, project.name[lang], { family: SERIF, style: 'normal', color: colors.primary, ...OG_TYPE.projectName });
  const outcome = textBlock(fonts, project.oneLineOutcome[lang], { family: SERIF, style: 'normal', color: colors.soft, ...OG_TYPE.outcome });
  const credit = textBlock(fonts, content.name, { family: SERIF, style: 'normal', color: colors.dawn, ...OG_TYPE.credit });
  const rule = div({ height: RULE_HEIGHT, width: TEXT_WIDTH, backgroundColor: colors.hairline });
  return frame(colors, [
    caps,
    div({ display: 'flex', flexDirection: 'column', gap: 24 }, [name, outcome]),
    div({ display: 'flex', flexDirection: 'column', gap: 14 }, [credit, rule]),
  ]);
}

/** Rasterises an element tree to an 8-bit RGB PNG of exactly OG_WIDTH×OG_HEIGHT. */
export async function renderTree(tree: OgNode, colors: OgColors, fonts: OgFonts): Promise<Buffer> {
  const svg = await satori(tree, { width: OG_WIDTH, height: OG_HEIGHT, fonts: fonts.satori });
  const image = new Resvg(svg, {
    fitTo: { mode: 'original' },
    background: colors.panel,
    font: { loadSystemFonts: false },
  }).render();
  if (image.width !== OG_WIDTH || image.height !== OG_HEIGHT) {
    throw new Error(`rendered ${image.width}×${image.height}, expected ${OG_WIDTH}×${OG_HEIGHT}`);
  }
  return encodeRgbPng(image.pixels, image.width, image.height);
}

/** The site image for `lang`. */
export function renderSiteImage(input: RenderInput): Promise<Buffer> {
  return renderTree(siteImageTree(input), input.colors, input.fonts);
}

/** The image of `project` for `lang`. */
export function renderProjectImage(input: RenderInput, project: OgProject): Promise<Buffer> {
  return renderTree(projectImageTree(input, project), input.colors, input.fonts);
}
