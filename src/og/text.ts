// Text measuring and wrapping for the OG images (Story 1.10). Pure module.
// Lines are wrapped here (not by the renderer) so the line limit and the
// ellipsis are deterministic and unit-tested; each line is then rendered
// without further wrapping.
import type { FontMetrics } from './fonts.ts';

export const ELLIPSIS = '…';

/** Width of `text` in px. */
export type Measure = (text: string) => number;

/**
 * A measure from font metrics: each code point uses the first font (subset)
 * that has it; a code point no font has counts as `fallbackEm` em.
 * Kerning is ignored (it mostly tightens text, so measured widths err wide).
 */
export function fontMeasure(
  metrics: readonly FontMetrics[],
  fontSize: number,
  letterSpacing = 0,
  fallbackEm = 0.6,
): Measure {
  if (metrics.length === 0) throw new Error('fontMeasure: no font metrics');
  return (text) => {
    let width = 0;
    let count = 0;
    for (const char of text) {
      const cp = char.codePointAt(0)!;
      let em = fallbackEm;
      for (const font of metrics) {
        const advance = font.advance(cp);
        if (advance !== undefined) {
          em = advance / font.unitsPerEm;
          break;
        }
      }
      width += em * fontSize;
      count++;
    }
    return width + letterSpacing * count;
  };
}

export interface WrapOptions {
  /** Available line width in px. */
  maxWidth: number;
  /** Maximum number of lines; text beyond it is cut and the last line ends in an ellipsis. */
  maxLines: number;
  measure: Measure;
}

/** Splits a word wider than `maxWidth` into pieces that fit (at least one character each). */
function breakWord(word: string, maxWidth: number, measure: Measure): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const char of word) {
    if (piece !== '' && measure(piece + char) > maxWidth) {
      pieces.push(piece);
      piece = char;
    } else {
      piece += char;
    }
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}

const TRAILING = /[\s,.;:!?\-–—]+$/u;
const ellipsized = (text: string) => `${text.replace(TRAILING, '')}${ELLIPSIS}`;

/**
 * `line` ending in an ellipsis that fits: trailing spaces/punctuation are
 * dropped, then whole trailing words, and only a single remaining word is
 * shortened by character.
 */
function withEllipsis(line: string, maxWidth: number, measure: Measure): string {
  const words = line.trim().split(' ');
  while (words.length > 1 && measure(ellipsized(words.join(' '))) > maxWidth) words.pop();
  const chars = [...words.join(' ')];
  for (;;) {
    const candidate = ellipsized(chars.join(''));
    if (measure(candidate) <= maxWidth || chars.length <= 1) return candidate;
    chars.pop();
  }
}

/**
 * Greedy word wrap of `text` (whitespace collapsed) into at most `maxLines`
 * lines no wider than `maxWidth`. Words wider than a line are broken by
 * character. When text remains after the last allowed line, that line ends
 * in an ellipsis. Returns at least one line for non-empty text; [] for blank text.
 */
export function wrapText(text: string, { maxWidth, maxLines, measure }: WrapOptions): string[] {
  if (!(maxWidth > 0) || !Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error(`wrapText: invalid options maxWidth=${maxWidth} maxLines=${maxLines}`);
  }
  const words = text.trim().split(/\s+/).filter((word) => word !== '');
  const tokens = words.flatMap((word) => (measure(word) > maxWidth ? breakWord(word, maxWidth, measure) : [word]));
  const lines: string[] = [];
  let line = '';
  let index = 0;
  for (; index < tokens.length; index++) {
    const token = tokens[index]!;
    const candidate = line === '' ? token : `${line} ${token}`;
    if (line === '' || measure(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = token;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines) {
    if (line !== '') lines.push(line);
    return lines;
  }
  // Out of lines with text left over: the last line gets the ellipsis.
  lines[maxLines - 1] = withEllipsis(lines[maxLines - 1]!, maxWidth, measure);
  return lines;
}
