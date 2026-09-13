import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMagicLink } from "../server/utils/email";

const resendKey = process.env.RESEND_API_KEY;
const from = process.env.AUTH_EMAIL_FROM;

afterEach(() => {
  vi.unstubAllGlobals();
  if (resendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = resendKey;
  if (from === undefined) delete process.env.AUTH_EMAIL_FROM;
  else process.env.AUTH_EMAIL_FROM = from;
});

describe("Resend failures", () => {
  it("streams and truncates a large provider error before logging its excerpt", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.AUTH_EMAIL_FROM = "Mahonia <noreply@example.test>";
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode("x".repeat(16_000)));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 502 })));

    await expect(
      sendMagicLink({
        to: "walker@example.test",
        url: "https://mahonia.test/auth/verify?token=abc",
        expiresIn: "15 minutes",
      }),
    ).rejects.toThrow(/^Resend responded 502: x{500}$/);

    // Response construction may prefetch one chunk, but the capped reader
    // cancels before it can walk an unbounded provider error stream.
    expect(pulled).toBeLessThanOrEqual(2);
    expect(cancelled).toBe(true);
  });
});
