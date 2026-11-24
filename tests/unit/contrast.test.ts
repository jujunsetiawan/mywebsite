// WCAG 2.x contrast computed from the DESIGN.md token values (Story 1.3).
import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, parseHex, readDesign, toHex, type Rgb } from './helpers/design-tokens.ts';

const design = readDesign();
const c = (group: string, name: string): string => {
  const value = design.colors[group]?.[name];
  if (value === undefined) throw new Error(`DESIGN.md colors.${group}.${name} is missing`);
  return String(value);
};
const opaque = (hex: string): Rgb => parseHex(hex).rgb;

const letterbox = opaque(c('surface', 'letterbox'));
const panel = opaque(c('surface', 'panel'));
// Worst case for film text: the scrim composited over a full lightning frame.
const scrimOverLightning = composite(c('surface', 'scrim'), c('scene', 'lightning'));
const scrimOverBlack = composite(c('surface', 'scrim'), c('surface', 'letterbox'));
// The name-card input rule colour lives in the component tokens.
const inputRule = (() => {
  const rule = String(design.components['name-card']?.['input-rule'] ?? '');
  const hex = /#[0-9a-f]{6}\b/i.exec(rule)?.[0];
  if (!hex) throw new Error(`components.name-card.input-rule has no hex colour: "${rule}"`);
  return hex;
})();

interface Pair {
  name: string;
  fg: Rgb;
  bg: Rgb;
  min: number;
}

const textPairs: Pair[] = [
  { name: 'ink.primary on surface.letterbox', fg: opaque(c('ink', 'primary')), bg: letterbox, min: 4.5 },
  { name: 'ink.soft on surface.letterbox (chrome nav)', fg: opaque(c('ink', 'soft')), bg: letterbox, min: 4.5 },
  { name: 'ink.primary on scrim over lightning', fg: opaque(c('ink', 'primary')), bg: scrimOverLightning, min: 4.5 },
  { name: 'ink.primary on surface.panel', fg: opaque(c('ink', 'primary')), bg: panel, min: 4.5 },
  { name: 'scene.dawn-2 on surface.panel', fg: opaque(c('scene', 'dawn-2')), bg: panel, min: 4.5 },
  { name: 'ink.on-light on ink.primary', fg: opaque(c('ink', 'on-light')), bg: opaque(c('ink', 'primary')), min: 4.5 },
  { name: `input rule ${inputRule} on surface.panel`, fg: opaque(inputRule), bg: panel, min: 3.0 },
  // Non-text contrast on the name-card sheet (scrim over a dark frame). Jun's
  // decision (Story 1.3): not required over a full lightning frame (2.72:1).
  { name: `input rule ${inputRule} on scrim over black`, fg: opaque(inputRule), bg: scrimOverBlack, min: 3.0 },
];

describe('contrast (WCAG 2.x relative luminance)', () => {
  it('composites the scrim over lightning to #313230 as documented in DESIGN.md', () => {
    expect(toHex(scrimOverLightning)).toBe('#313230');
  });

  for (const pair of textPairs) {
    it(`${pair.name} ≥ ${pair.min}`, () => {
      const ratio = contrastRatio(pair.fg, pair.bg);
      console.info(`contrast ${pair.name}: ${ratio.toFixed(2)}:1 (min ${pair.min})`);
      expect(ratio, `${pair.name} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(pair.min);
    });
  }
});
