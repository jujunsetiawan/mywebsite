// Adapters are the only layer allowed to touch browser globals.
import { progress } from '../systems/timeline.ts';

export function bind(): number {
  return progress({ location: window.innerWidth }, document.body.childElementCount);
}
