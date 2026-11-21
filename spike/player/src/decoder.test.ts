// THROWAWAY — Story 0.4 spike player tests. Not production code; delete after Epic 0.
import { describe, expect, it } from "vitest";
import { Decoder, type DecodeRequest, type DecodeResponse, type WorkerLike } from "./decoder.ts";

class FakeWorker implements WorkerLike {
  onmessage: ((ev: { data: DecodeResponse }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  terminated = false;
  posted: DecodeRequest[] = [];
  constructor(private behaviour: "ok" | "fail" | "fatal") {}
  setBehaviour(b: "ok" | "fail" | "fatal"): void {
    this.behaviour = b;
  }
  postMessage(msg: DecodeRequest): void {
    this.posted.push(msg);
    const b = this.behaviour;
    queueMicrotask(() => {
      const reply: DecodeResponse =
        b === "ok"
          ? { id: msg.id, ok: true, bitmap: { from: "worker" } as unknown as ImageBitmap, ms: 3 }
          : b === "fatal"
            ? { id: msg.id, ok: false, fatal: true, error: "no createImageBitmap", bytes: msg.bytes }
            : { id: msg.id, ok: false, error: "decode error" };
      this.onmessage?.({ data: reply });
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

function deps(createWorker: () => WorkerLike | null) {
  const logs: string[] = [];
  let mainCalls = 0;
  return {
    logs,
    get mainCalls() { return mainCalls; },
    deps: {
      createWorker,
      mainDecode: async () => {
        mainCalls++;
        return { from: "main" };
      },
      now: () => 0,
      log: (m: string) => logs.push(m),
    },
  };
}

const bytes = () => new Uint8Array([1, 2, 3]).buffer;

describe("decoder: worker path", () => {
  it("decodes in the worker and transfers the caller's buffer (no extra copy)", async () => {
    const w = new FakeWorker("ok");
    const d = deps(() => w);
    const dec = new Decoder<{ from: string }>(d.deps);
    expect(dec.path).toBe("worker");
    const buf = bytes();
    const r = await dec.decode(buf);
    expect(w.posted[0]!.bytes).toBe(buf);
    expect(r.path).toBe("worker");
    expect(r.bitmap).toEqual({ from: "worker" });
    expect(d.mainCalls).toBe(0);
    expect(w.posted[0]!.bytes.byteLength).toBe(3);
  });
});

describe("matrix: worker fails", () => {
  it("worker unavailable => main-thread decode, path main, logged once", async () => {
    const d = deps(() => null);
    const dec = new Decoder<{ from: string }>(d.deps);
    expect(dec.path).toBe("main");
    const r = await dec.decode(bytes());
    await dec.decode(bytes());
    expect(r.path).toBe("main");
    expect(d.logs.length).toBe(1);
  });

  it("worker constructor throws => main", async () => {
    const d = deps(() => { throw new Error("SecurityError"); });
    const dec = new Decoder<{ from: string }>(d.deps);
    expect(dec.path).toBe("main");
    expect((await dec.decode(bytes())).bitmap).toEqual({ from: "main" });
    expect(d.logs).toHaveLength(1);
    expect(dec.fallbackReason).toMatch(/SecurityError/);
  });

  it("a single failed frame decode rejects that frame only; the worker stays active", async () => {
    const w = new FakeWorker("fail");
    const d = deps(() => w);
    const dec = new Decoder<{ from: string }>(d.deps);
    await expect(dec.decode(bytes())).rejects.toThrow(/worker decode failed: decode error/);
    expect(dec.path).toBe("worker");
    expect(w.terminated).toBe(false);
    expect(d.logs).toHaveLength(0);
    expect(d.mainCalls).toBe(0);
    w.setBehaviour("ok");
    const r = await dec.decode(bytes());
    expect(r.path).toBe("worker");
  });

  it("createImageBitmap unavailable in the worker (fatal) => retried on main, switches permanently, logged once", async () => {
    const w = new FakeWorker("fatal");
    const d = deps(() => w);
    const dec = new Decoder<{ from: string }>(d.deps);
    const a = await dec.decode(bytes());
    expect(a.path).toBe("main");
    expect(dec.path).toBe("main");
    expect(w.terminated).toBe(true);
    const c = await dec.decode(bytes());
    expect(c.path).toBe("main");
    expect(w.posted.length).toBe(1); // nothing more sent to the dead worker
    expect(d.logs).toHaveLength(1);
  });

  it("worker onerror => main for later decodes; in-flight decode rejected (bytes were transferred)", async () => {
    const w = new FakeWorker("ok");
    w.postMessage = function () { /* never replies */ };
    const d = deps(() => w);
    const dec = new Decoder<{ from: string }>(d.deps);
    const p = dec.decode(bytes());
    w.onerror?.({ message: "boom" });
    await expect(p).rejects.toThrow(/switched to main thread/);
    expect(dec.path).toBe("main");
    expect(w.terminated).toBe(true);
    expect((await dec.decode(bytes())).path).toBe("main");
    expect(d.logs).toHaveLength(1);
  });
});

describe("decoder: dispose", () => {
  it("rejects pending decodes", async () => {
    const w = new FakeWorker("ok");
    w.postMessage = function () { /* never replies */ };
    const dec = new Decoder<{ from: string }>(deps(() => w).deps);
    const p = dec.decode(bytes());
    dec.dispose();
    await expect(p).rejects.toThrow(/disposed/);
    expect(w.terminated).toBe(true);
  });
});
