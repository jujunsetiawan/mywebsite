// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
//
// Frame decoder: decode in a dedicated Worker (ImageBitmap transferred back).
// If the worker cannot be created, fires `onerror`, or reports that it cannot
// decode at all (no createImageBitmap), switch permanently to main-thread
// createImageBitmap (logged once). A single failed frame decode only rejects
// that frame. The active path is exposed as `path` for the HUD.
//
// Dependencies are injectable so the fallback logic is unit-testable in Node.

export type DecodePath = "worker" | "main";

export interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  type: string;
}

export type DecodeResponse =
  | { id: number; ok: true; bitmap: ImageBitmap; ms: number }
  /** `fatal`: the worker can never decode (e.g. no createImageBitmap); `bytes` returned for a main-thread retry. */
  | { id: number; ok: false; error: string; fatal?: boolean; bytes?: ArrayBuffer };

export interface DecodeResult<B = ImageBitmap> {
  bitmap: B;
  ms: number;
  path: DecodePath;
}

/** Minimal Worker surface used here. */
export interface WorkerLike {
  postMessage(msg: DecodeRequest, transfer: Transferable[]): void;
  onmessage: ((ev: { data: DecodeResponse }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  terminate(): void;
}

export interface DecoderDeps<B = ImageBitmap> {
  /** Create the worker; may throw (unsupported) or return null. */
  createWorker: () => WorkerLike | null;
  /** Main-thread decode of the encoded bytes. */
  mainDecode: (bytes: ArrayBuffer, type: string) => Promise<B>;
  now: () => number;
  log: (msg: string) => void;
}

export class Decoder<B = ImageBitmap> {
  path: DecodePath = "main";
  fallbackReason: string | null = null;
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: DecodeResult<B>) => void; reject: (e: Error) => void; type: string }>();
  private logged = false;

  constructor(private readonly deps: DecoderDeps<B>) {
    try {
      const w = deps.createWorker();
      if (w) {
        this.worker = w;
        this.path = "worker";
        w.onmessage = (ev) => this.onWorkerMessage(ev.data);
        w.onerror = (ev) => this.fallBack(`worker error: ${describe(ev)}`);
      } else {
        this.fallBack("Worker unavailable");
      }
    } catch (e) {
      this.fallBack(`Worker construction failed: ${describe(e)}`);
    }
  }

  /**
   * Decode one encoded frame. `bytes` must be a private copy of the frame's
   * slice: on the worker path it is transferred (detached) without another copy.
   */
  decode(bytes: ArrayBuffer, type = "image/avif"): Promise<DecodeResult<B>> {
    if (this.path === "worker" && this.worker) {
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, type });
        try {
          this.worker!.postMessage({ id, bytes, type }, [bytes]);
        } catch (e) {
          this.pending.delete(id);
          this.fallBack(`postMessage failed: ${describe(e)}`);
          if (bytes.byteLength > 0) this.decodeMain(bytes, type).then(resolve, reject);
          else reject(new Error("decode request lost while falling back to main thread"));
        }
      });
    }
    return this.decodeMain(bytes, type);
  }

  private async decodeMain(bytes: ArrayBuffer, type: string): Promise<DecodeResult<B>> {
    const t0 = this.deps.now();
    const bitmap = await this.deps.mainDecode(bytes, type);
    return { bitmap, ms: this.deps.now() - t0, path: "main" };
  }

  private onWorkerMessage(msg: DecodeResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) {
      p.resolve({ bitmap: msg.bitmap as unknown as B, ms: msg.ms, path: "worker" });
    } else if (msg.fatal) {
      // The worker cannot decode at all (no createImageBitmap): switch for good,
      // and retry this frame on the main thread with the bytes it sent back.
      this.fallBack(`worker cannot decode: ${msg.error}`);
      if (msg.bytes && msg.bytes.byteLength > 0) this.decodeMain(msg.bytes, p.type).then(p.resolve, p.reject);
      else p.reject(new Error(msg.error));
    } else {
      // A single bad frame: reject that frame only; the worker stays the active path.
      p.reject(new Error(`worker decode failed: ${msg.error}`));
    }
  }

  /**
   * Permanently switch to main-thread decode. Pending requests' bytes were
   * transferred to the dead worker, so they are rejected (the caller retries).
   */
  private fallBack(reason: string): void {
    if (!this.logged) {
      this.logged = true;
      this.deps.log(`[decoder] falling back to main-thread decode: ${reason}`);
    }
    if (this.path === "main" && !this.worker) {
      this.fallbackReason ??= reason;
      return;
    }
    this.path = "main";
    this.fallbackReason = reason;
    const w = this.worker;
    this.worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
    }
    this.rejectPending(`decode lost: switched to main thread (${reason})`);
  }

  private rejectPending(message: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new Error(message));
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.rejectPending("decoder disposed");
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
