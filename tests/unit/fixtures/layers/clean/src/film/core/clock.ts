// Pure core module: no imports from systems or adapters.
export type Clock = { fps: number };
export const toSeconds = (frames: number, fps: number): number => frames / fps;
