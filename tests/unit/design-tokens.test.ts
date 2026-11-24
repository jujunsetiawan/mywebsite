import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_MD,
  PAPER_HEX,
  diffTokens,
  expectedTokens,
  parseCssTokens,
  readDesign,
  readStyleSources,
  scanStyleRules,
  TOKENS_CSS,
  TYPE_STYLES,
} from './helpers/design-tokens.ts';

const design = readDesign();
const expected = expectedTokens(design);
const css = readFileSync(TOKENS_CSS, 'utf8');

describe('tokens.css matches docs/design/DESIGN.md frontmatter', () => {
  it('has every mapped token, no extras, and identical values', () => {
    expect(diffTokens(expected, parseCssTokens(css))).toEqual([]);
  });

  it('maps every colour group, spacing, radius and the eight active type styles', () => {
    const names = [...expected.keys()];
    for (const prefix of ['--scene-', '--signal-', '--ink-', '--surface-', '--space-', '--radius-']) {
      expect(names.some((n) => n.startsWith(prefix)), prefix).toBe(true);
    }
    for (const style of TYPE_STYLES) {
      expect(expected.has(`--type-${style}-family`), style).toBe(true);
      expect(expected.has(`--type-${style}-size`), style).toBe(true);
      expect(expected.has(`--type-${style}-line-height`), style).toBe(true);
    }
    expect(names.some((n) => n.includes('kanji-vertical'))).toBe(false);
  });

  it('every built type style is weight 400 in DESIGN.md', () => {
    for (const style of TYPE_STYLES) expect(String(design.typography[style]?.fontWeight), style).toBe('400');
  });

  it('a drifted value fails naming the token and both values', () => {
    const drifted = css.replace('--ink-primary: #F1EBE0;', '--ink-primary: #FFFFFF;');
    expect(diffTokens(expected, parseCssTokens(drifted))).toEqual([
      '--ink-primary differs: DESIGN.md "#F1EBE0" vs tokens.css "#FFFFFF"',
    ]);
  });

  it('a missing token fails naming it; an unmapped extra fails too', () => {
    const missing = css.replace(/^\s*--space-section:.*$/m, '');
    expect(diffTokens(expected, parseCssTokens(missing))).toEqual(['missing --space-section (DESIGN.md: 64px)']);
    const extra = css.replace(':root {', ':root {\n  --brand-accent: #ff00ff;');
    expect(diffTokens(expected, parseCssTokens(extra))).toEqual(['extra --brand-accent (not mapped from DESIGN.md)']);
  });

  it('values compare after whitespace normalisation and case-insensitive hex', () => {
    const reformatted = css
      .replace('--scene-night: #0F2226;', '--scene-night:   #0f2226 ;')
      .replace('clamp(40px, 10dvh, 96px)', 'clamp(40px,  10dvh,\n    96px)');
    expect(diffTokens(expected, parseCssTokens(reformatted))).toEqual([]);
  });
});

describe('style rules in src/**/*.{css,astro}', () => {
  it('no forbidden text colour, pure white text, extra box-shadow, bold, rounded corner or web font', () => {
    expect(scanStyleRules(readStyleSources())).toEqual([]);
  });

  it('flags signal.error / alarm-red / beacon-red text colour with file:line', () => {
    const problems = scanStyleRules([
      {
        file: 'src/x.css',
        text: [
          '.a { color: var(--signal-error-text); }',
          '.b { color: var(--signal-error); }',
          '.c { background-color: var(--signal-alarm-red); }',
          '.d { color: var(--signal-beacon-red); }',
          '.e { border-color: var(--signal-error); }',
        ].join('\n'),
      },
    ]);
    expect(problems).toEqual([
      'src/x.css:2 — text colour uses var(--signal-error) (fill/light only, never text)',
      'src/x.css:4 — text colour uses var(--signal-beacon-red) (fill/light only, never text)',
    ]);
  });

  it('allows the paper tone as the single documented non-token hex colour (Story 1.6)', () => {
    // Documented in the DESIGN.md set-dressing prose.
    expect(readFileSync(DESIGN_MD, 'utf8')).toContain(`\`${PAPER_HEX}\``);
    const problems = scanStyleRules([
      {
        file: 'src/styles/z.css',
        text: [
          `.paper { background: ${PAPER_HEX}; color: var(--ink-on-light); }`,
          '.paper-lower { background: #d8d0c0; }',
          '.x { background: #B9A774; }',
          '.y { color: var(--ink-primary); } /* #123456 in a comment */',
        ].join('\n'),
      },
      { file: 'src/styles/tokens.css', text: ':root { --x: #123456; }' },
    ]);
    expect(problems).toEqual([
      'src/styles/z.css:3 — colour #B9A774 is not a token (only #000, #d8d0c0 are allowed)',
    ]);
  });

  it('allows only the focus halo box-shadow, weight 400 and 0/pill radii', () => {
    const problems = scanStyleRules([
      {
        file: 'src/y.css',
        text: [
          ':focus-visible { box-shadow: 0 0 0 4px #000; }',
          '.card { box-shadow: 0 2px 8px rgba(0,0,0,.4); }',
          '.t { font-weight: 700; }',
          '.r { border-radius: 8px; }',
          '.p { border-radius: var(--radius-pill); }',
          '.n { box-shadow: none; }',
        ].join('\n'),
      },
    ]);
    expect(problems).toEqual([
      'src/y.css:2 — box-shadow "0 2px 8px rgba(0,0,0,.4)" (only the focus halo "0 0 0 4px #000" is allowed)',
      'src/y.css:3 — font-weight 700 (400 only)',
      'src/y.css:4 — border-radius 8px (0 or var(--radius-pill) only)',
    ]);
  });
});
