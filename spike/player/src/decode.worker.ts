// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Dedicated decode worker: chunk slice bytes -> createImageBitmap -> ImageBitmap
// transferred back to the main thread.

/// <reference lib="webworker" />

import type { DecodeRequest, DecodeResponse } from "./decoder.ts";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<DecodeRequest>) => {
  const { id, bytes, type } = ev.data;
  const t0 = performance.now();
  if (typeof createImageBitmap !== "function") {
    // Permanent: the main thread falls back and retries with the returned bytes.
    const msg: DecodeResponse = { id, ok: false, fatal: true, error: "createImageBitmap unavailable in worker", bytes };
    ctx.postMessage(msg, [bytes]);
    return;
  }
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    const msg: DecodeResponse = { id, ok: true, bitmap, ms: performance.now() - t0 };
    ctx.postMessage(msg, [bitmap]);
  } catch (e) {
    const msg: DecodeResponse = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
    ctx.postMessage(msg);
  }
};
