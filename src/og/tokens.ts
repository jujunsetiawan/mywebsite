// Colour tokens for the build-time Open Graph images (Story 1.10), read from
// `src/styles/tokens.css` so the images use exactly the site's palette (no new
// colours). Pure module: no Astro or Node imports.

/** Custom properties declared in `:root` blocks of a stylesheet (comments ignored). */
export function parseCssTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of clean.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const decl of (block[1] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(decl[1] ?? '', (decl[2] ?? '').trim());
    }
  }
  return tokens;
}

/** The tokens an OG image uses, by role, with their CSS custom property. */
export const OG_COLOR_TOKENS = {
  /** surface.panel — the image background. */
  panel: '--surface-panel',
  /** surface.hairline — the rule under the project image's credit line. */
  hairline: '--surface-hairline',
  /** ink.primary — the serif name. */
  primary: '--ink-primary',
  /** ink.soft — job title / one-line outcome. */
  soft: '--ink-soft',
  /** ink.muted — the top caps line. */
  muted: '--ink-muted',
  /** scene.dawn-2 — the "Jujun Setiawan" credit line on project images. */
  dawn: '--scene-dawn-2',
} as const;

export type OgColors = Record<keyof typeof OG_COLOR_TOKENS, string>;

/**
 * The OG colours from a tokens stylesheet. Throws naming the property when a
 * token is missing or not an opaque `#RRGGBB` hex (the images have no transparency).
 */
export function ogColors(css: string): OgColors {
  const tokens = parseCssTokens(css);
  const colors = {} as OgColors;
  for (const [role, property] of Object.entries(OG_COLOR_TOKENS) as [keyof OgColors, string][]) {
    const value = tokens.get(property);
    if (value === undefined) throw new Error(`og tokens: ${property} is missing from tokens.css`);
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`og tokens: ${property} must be an opaque #RRGGBB colour, got "${value}"`);
    colors[role] = value.toUpperCase();
  }
  return colors;
}
