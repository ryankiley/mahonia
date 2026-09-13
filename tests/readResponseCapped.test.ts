import { describe, expect, it } from "vitest";
import { readResponseCapped } from "../server/utils/http";

// The thing worth pinning down is that the reader STOPS. A cap applied after
// `res.text()` would satisfy every assertion about the returned value while
// still pulling the whole body into memory first — so `pulled` counts the chunks
// the stream actually handed over, and that count is the real assertion.

/** A Response whose body yields `chunks` one at a time, recording how many were
 *  read before the consumer let go. */
function streamed(chunks: Uint8Array[], onCancel?: () => void | Promise<void>) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks[state.pulled];
      if (!next) return controller.close();
      state.pulled++;
      controller.enqueue(next);
    },
    cancel() {
      state.cancelled = true;
      return onCancel?.();
    },
  });
  return { res: new Response(body), state };
}

const kb = (n: number, fill = 0x61) => new Uint8Array(n * 1024).fill(fill);

describe("readResponseCapped", () => {
  it("returns the whole body when it fits under the cap", async () => {
    const { res } = streamed([new TextEncoder().encode("brand,name,weight\n")]);
    const read = await readResponseCapped(res, 1024, "reject");
    expect(read.ok).toBe(true);
    expect(read.ok && read.body?.toString("utf8")).toBe("brand,name,weight\n");
  });

  it("reports an empty body as ok with nothing in it, NOT as oversize", async () => {
    const { res } = streamed([]);
    const read = await readResponseCapped(res, 1024, "reject");
    expect(read).toEqual({ ok: true, body: null });
  });

  it("rejects past the cap and cancels rather than draining the rest", async () => {
    // ten 64 KB chunks against a 128 KB cap: a reader that ran to completion
    // would pull all ten
    const { res, state } = streamed(Array.from({ length: 10 }, () => kb(64)));
    const read = await readResponseCapped(res, 128 * 1024, "reject");
    expect(read).toEqual({ ok: false, reason: "oversize" });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(3);
  });

  it("truncates past the cap instead, when the caller only wants the prefix", async () => {
    const { res, state } = streamed(Array.from({ length: 10 }, () => kb(64)));
    const read = await readResponseCapped(res, 128 * 1024, "truncate");
    expect(read.ok).toBe(true);
    expect(read.ok && read.body).not.toBeNull();
    // what it kept is exactly the capped prefix, even though the final read was
    // a full 64 KB network chunk.
    expect(read.ok && read.body!.byteLength).toBe(128 * 1024);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(3);
  });

  it("does not retain a single oversized chunk when truncating", async () => {
    const { res, state } = streamed([kb(512, 0x62), kb(512, 0x63)]);
    const read = await readResponseCapped(res, 128 * 1024, "truncate");
    expect(read.ok).toBe(true);
    expect(read.ok && read.body).not.toBeNull();
    expect(read.ok && read.body!.byteLength).toBe(128 * 1024);
    expect(read.ok && read.body![0]).toBe(0x62);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBe(1);
  });

  it("owns a truncated prefix before cancellation can mutate its oversized source", async () => {
    const source = kb(512, 0x62);
    const { res } = streamed([source], () => { source.fill(0x63); });
    const read = await readResponseCapped(res, 128 * 1024, "truncate");
    // A retained subarray would now read 0x63 because it shares source.buffer.
    expect(read.ok && read.body![0]).toBe(0x62);
  });

  it("keeps the <head> at the front of a truncated read — the reason truncate exists", async () => {
    const head = new TextEncoder().encode('<head><link rel="icon" href="/i.png">');
    const { res } = streamed([head, kb(512), kb(512)]);
    const read = await readResponseCapped(res, 256 * 1024, "truncate");
    expect(read.ok && read.body!.toString("utf8")).toContain('rel="icon"');
  });

  it("handles a body-less response (a HEAD, a 204) without throwing", async () => {
    const read = await readResponseCapped(new Response(null, { status: 204 }), 1024, "reject");
    expect(read).toEqual({ ok: true, body: null });
  });
});
