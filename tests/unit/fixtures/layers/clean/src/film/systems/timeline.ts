// Systems may import core. Mentions of window or document in comments,
// strings and property names are not browser-global references.
import { toSeconds } from '../core/clock.ts';
import type { Clock } from '/src/film/core/clock.ts';

/* A block comment about requestAnimationFrame and localStorage. */
const label = 'window document navigator';
const template = `uses ${label.length} chars, not location`;

export function progress(state: { location: number }, frames: number): number {
  return state.location + toSeconds(frames, 24) + template.length;
}

export type { Clock };
