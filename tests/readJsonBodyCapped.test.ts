// The inbound counterpart to readResponseCapped: endpoint bodies must be bounded
// while they are read, not only after H3 has concatenated a chunked upload.
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent } from "h3";
import { describe, expect, it } from "vitest";
import { readJsonBodyCapped } from "../server/utils/http";

function eventFor(chunks: string[], headers: Record<string, string> = {}) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = "/";
  req.headers = { host: "mahonia.test", ...headers };
  for (const chunk of chunks) req.push(Buffer.from(chunk));
  req.push(null);
  return createEvent(req, new ServerResponse(req));
}

async function refusal(event: ReturnType<typeof eventFor>, maxBytes: number) {
  try {
    await readJsonBodyCapped(event, maxBytes);
  } catch (error) {
    return error as { statusCode?: number; statusMessage?: string };
  }
  throw new Error("expected a refusal");
}

describe("readJsonBodyCapped", () => {
  it("parses a valid body that arrives across chunks", async () => {
    const event = eventFor(['{"name":"', 'Tent"}']);
    await expect(readJsonBodyCapped<{ name: string }>(event, 64)).resolves.toEqual({ name: "Tent" });
  });

  it("rejects a chunked body past the cap even when Content-Length lies", async () => {
    const event = eventFor(['{"note":"', "x".repeat(256), '"}'], { "content-length": "2" });
    await expect(refusal(event, 64)).resolves.toMatchObject({ statusCode: 413, statusMessage: "Payload too large" });
  });

  it("rejects an oversized claimed length before buffering a body", async () => {
    const event = eventFor([], { "content-length": "1000" });
    await expect(refusal(event, 64)).resolves.toMatchObject({ statusCode: 413, statusMessage: "Payload too large" });
  });

  it("keeps the established empty-object fallback for malformed input", async () => {
    await expect(readJsonBodyCapped(eventFor(["{" ]), 64)).resolves.toEqual({});
  });
});
