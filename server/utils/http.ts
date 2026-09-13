import { createError, getHeader, readRawBody, setHeader, type H3Event } from "h3";

/**
 * Keep a response out of search results.
 *
 * Nearly every endpoint here wants this — an API response is somebody's list,
 * gear or account, and none of it is a page. One deliberately doesn't call it:
 * /api/l/[slug], which backs the indexable public read.
 *
 * A helper rather than a wrapper that sets it for you. The obvious next step —
 * defineApiHandler(action, handler), headers and rate limit together — is a trap
 * this codebase would spring immediately: requireAdmin (the cron routes' gate
 * too) already calls rateLimit("admin") itself, so a wrapper that also called it
 * would charge the same budget twice on every admin and cron request; two catalog
 * endpoints deliberately rate-limit BEFORE setting their cache headers, so a 429
 * is never cached at the edge, which a fixed order would undo; and auth/request
 * rate-limits twice, on two different subjects, at two points in its body. Three
 * separate one-line calls can express all of that. One wrapper can't.
 *
 * The one bundle that IS safe is requireAccount (authSession.ts): the
 * session-gated account endpoints all set both headers and rate-limit before
 * resolving the session, and none of them go near requireAdmin.
 */
export function setNoIndex(event: H3Event): void {
  setHeader(event, "X-Robots-Tag", "noindex");
}

/** Mark a response as this caller's own data — never held by a shared or edge
 *  cache, never written to disk by the browser. Pairs with setNoIndex on every
 *  endpoint that answers with something belonging to one person. */
export function setPrivate(event: H3Event): void {
  setHeader(event, "Cache-Control", "private, no-store");
}

/** The read views' shared edge window: collapses the burst when a share link
 *  makes the rounds, at the accepted cost of 30 s of staleness on a read-only
 *  surface. One helper because it's one INVARIANT — the pair a crawler fetches
 *  (a list's HTML via /api/s | /api/l, then its card image via /og) must go
 *  stale together, which six copies of a header literal can't promise. The two
 *  read PAGES (/s, /l) state the same window via useResponseHeader; app code
 *  can't reach this helper, so those two literals remain. */
export function setReadEdgeCache(event: H3Event): void {
  setHeader(event, "Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=120");
}

/** A day of edge cache for the static, same-for-everyone text routes (robots,
 *  llms.txt, the Apple app-site-association) — the daily counterpart of
 *  setReadEdgeCache, and one literal instead of three. */
export function setDailyEdgeCache(event: H3Event): void {
  setHeader(event, "Cache-Control", "public, max-age=0, s-maxage=86400");
}

/** The Bearer token on the request, "" when absent — the one reading of the
 *  Authorization header, shared by the edit-capability and cron gates. */
export function bearerToken(event: H3Event): string {
  const header = getHeader(event, "authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * The "that didn't resolve" 404 nearly every endpoint throws.
 *
 * Always the same words, on purpose: a list that was deleted, a snapshot
 * belonging to someone else, and a capability that never existed all have to read
 * identically, or the difference between them becomes an oracle. Only /api/import
 * passes its own message, and only because the thing not found is a LighterPack
 * URL the caller typed rather than anything of ours.
 *
 * Returns rather than throws, like h3's own createError, so the call site keeps
 * its explicit `throw` and reads as the exit it is.
 */
export function notFound(statusMessage = "Not found") {
  return createError({ statusCode: 404, statusMessage });
}

/**
 * Read a JSON body with a hard size cap on the ACTUAL bytes received rather
 * than the client-supplied Content-Length. A header-only check is bypassable by
 * omitting Content-Length or using chunked transfer-encoding, which then lets
 * an oversized body be buffered + JSON-parsed. Normal node requests are read
 * chunk by chunk and retain no more than the cap; adapters that hand H3 an
 * already-materialized body are still measured before parsing. Rejects with
 * 413 past `maxBytes`; falls back to `{}` on missing/malformed JSON so every
 * handler validates its own fields uniformly. (On Vercel a ~4.5 MB platform
 * limit backstops an adapter that buffers before our code can see it.)
 */
/** What reading a capped response body produced. `body: null` means the response
 *  was empty; `ok: false` means it went past the cap and the caller asked to
 *  reject rather than truncate. Two outcomes rather than one nullable Buffer,
 *  because "nothing came back" and "too much came back" are different answers
 *  and /api/import has to tell a caller which one it hit. */
type CappedBody = { ok: true; body: Buffer | null } | { ok: false; reason: "oversize" };

const H3_RAW_BODY = Symbol.for("h3RawBody");

function payloadTooLarge() {
  return createError({ statusCode: 413, statusMessage: "Payload too large" });
}

/** Buffer a Node request only up to its cap. On an overage, resume the request so
 * Node drains the socket without retaining the rest; that lets H3 send the 413
 * instead of leaving a keep-alive connection stalled behind unread bytes. */
function readNodeBodyCapped(event: H3Event, maxBytes: number): Promise<Buffer | null> {
  const req = event.node.req;
  const claimedLength = Number(getHeader(event, "content-length"));
  if (Number.isFinite(claimedLength) && claimedLength > maxBytes) {
    req.resume();
    return Promise.reject(payloadTooLarge());
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error: unknown, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) req.resume();
      reject(error);
    };
    const onData = (value: Uint8Array) => {
      const chunk = Buffer.from(value);
      if (chunk.length > maxBytes - total) return fail(payloadTooLarge(), true);
      total += chunk.length;
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(total ? Buffer.concat(chunks, total) : null);
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error("Request aborted"));
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

/** A Fetch/Web adapter can hand H3 a request body before it reaches node's
 * IncomingMessage. It still needs the same cap. Native web streams honour
 * cancellation, unlike h3's node-to-web bridge, so stopping here is safe. */
async function readWebBodyCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer | null> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.byteLength > maxBytes - total) {
        await reader.cancel();
        throw payloadTooLarge();
      }
      const chunk = Buffer.from(value);
      total += chunk.length;
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return total ? Buffer.concat(chunks, total) : null;
}

/** Whether an adapter has already supplied a body outside the node stream.
 * Buffers/objects supplied this way are already materialized by the platform;
 * readRawBody remains the compatibility path, but their parsed size is still
 * checked before a handler receives them. */
function hasPreReadBody(event: H3Event): boolean {
  const req = event.node.req as typeof event.node.req & { rawBody?: unknown; body?: unknown; [key: symbol]: unknown };
  return event._requestBody != null || req[H3_RAW_BODY] != null || req.rawBody != null || req.body != null;
}

/**
 * Read an OUTBOUND fetch's response body up to `maxBytes`, cancelling the stream
 * past it — the counterpart of readJsonBodyCapped, which does the same job for a
 * body somebody sent US.
 *
 * The cancel is the point. `await res.text()` runs to completion first and only
 * then lets you measure it, so a cap applied afterwards bounds what gets PARSED
 * and not what gets read: a third party answering with a few gigabytes holds the
 * function until the platform kills it, whatever the check says. Pulling chunks
 * and calling `reader.cancel()` at the cap is what actually stops the read.
 *
 * `onOversize` decides what hitting the cap MEANS, and the callers want opposite
 * things. An image or a CSV over the cap is a REJECT: half a file is useless.
 * HTML over the cap is a TRUNCATE, because only <head> is ever read and it's at
 * the very start — rejecting instead lost every site whose homepage is bigger
 * than the cap, which is most modern ones.
 *
 * Lived in trailFavicon.ts, which is where the streaming was first needed. Moved
 * here when /api/import turned out to have the same problem and a weaker guard.
 */
export async function readResponseCapped(
  res: Response,
  maxBytes: number,
  onOversize: "reject" | "truncate",
): Promise<CappedBody> {
  const reader = res.body?.getReader();
  if (!reader) return { ok: true, body: null };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      // Do not retain an entire oversized network chunk. A subarray is only a
      // view, so keeping one would keep the chunk's whole backing ArrayBuffer
      // alive until Buffer.concat runs. Copy just the prefix instead.
      if (onOversize === "truncate" && remaining > 0) {
        const prefix = new Uint8Array(remaining);
        prefix.set(value.subarray(0, remaining));
        chunks.push(prefix);
      }
      // stop pulling either way — we have what we need, or we've decided we don't want it
      await reader.cancel();
      if (onOversize === "reject") return { ok: false, reason: "oversize" };
      total = maxBytes;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  return { ok: true, body: total ? Buffer.concat(chunks.map((c) => Buffer.from(c))) : null };
}

/**
 * Read an inbound body with a hard cap on bytes received. Unlike h3's readRawBody,
 * normal Node requests are streamed, so a chunked request cannot allocate past the cap
 * before its consumer gets a chance to reject it. Callers that need protocol-specific
 * parse errors (MCP's JSON-RPC transport) use this raw form; ordinary JSON endpoints use
 * readJsonBodyCapped below for the established empty-object malformed-input fallback.
 */
export async function readBodyCapped(event: H3Event, maxBytes: number): Promise<Buffer | null> {
  const webBody = event.web?.request?.body ?? (event._requestBody instanceof ReadableStream ? event._requestBody : null);
  // `readRawBody` concatenates every incoming chunk before returning. Normal node
  // requests must go through the streaming path, otherwise a chunked body can bypass
  // Content-Length and allocate arbitrarily before this helper sees it.
  const raw = webBody
    ? await readWebBodyCapped(webBody, maxBytes)
    : hasPreReadBody(event)
      ? await readRawBody(event, false)
      : await readNodeBodyCapped(event, maxBytes);
  if (raw && raw.length > maxBytes) throw payloadTooLarge();
  return raw ?? null;
}

export async function readJsonBodyCapped<T>(event: H3Event, maxBytes: number): Promise<T> {
  let raw: Buffer | null;
  try {
    raw = await readBodyCapped(event, maxBytes);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 413) throw error;
    return {} as T;
  }
  if (!raw || raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    return {} as T;
  }
}
