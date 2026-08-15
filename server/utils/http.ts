import { createError, getHeader, readRawBody, setHeader, type H3Event } from "h3";

/**
 * Keep a response out of search results.
 *
 * Nearly every endpoint here wants this — an API response is somebody's list,
 * gear or account, and none of it is a page. Two deliberately don't call it:
 * /api/l/[slug], which backs the indexable public read, and /api/changelog,
 * which is checked-in public content.
 *
 * A helper rather than a wrapper that sets it for you. The obvious next step —
 * defineApiHandler(action, handler), headers and rate limit together — is a trap
 * this codebase would spring immediately: requireAdmin and requireCronAuth
 * already call rateLimit("admin") themselves, so a wrapper that also called it
 * would charge the same budget twice on every admin and cron request; two catalog
 * endpoints deliberately rate-limit BEFORE setting their cache headers, so a 429
 * is never cached at the edge, which a fixed order would undo; and auth/request
 * rate-limits twice, on two different subjects, at two points in its body. Three
 * separate one-line calls can express all of that. One wrapper can't.
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
 * an oversized body be buffered + JSON-parsed; reading the raw body and
 * measuring it closes that. Rejects with 413 past `maxBytes`; falls back to
 * `{}` on missing/malformed JSON so every handler validates its own fields
 * uniformly. (On Vercel a ~4.5 MB platform limit backstops the buffering
 * itself; this makes the per-endpoint cap authoritative.)
 */
/** What reading a capped response body produced. `body: null` means the response
 *  was empty; `ok: false` means it went past the cap and the caller asked to
 *  reject rather than truncate. Two outcomes rather than one nullable Buffer,
 *  because "nothing came back" and "too much came back" are different answers
 *  and /api/import has to tell a caller which one it hit. */
export type CappedBody = { ok: true; body: Buffer | null } | { ok: false; reason: "oversize" };

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
    total += value.byteLength;
    chunks.push(value);
    // stop pulling either way — we have what we need, or we've decided we don't want it
    if (total > maxBytes) {
      await reader.cancel();
      if (onOversize === "reject") return { ok: false, reason: "oversize" };
      break;
    }
  }
  return { ok: true, body: total ? Buffer.concat(chunks.map((c) => Buffer.from(c))) : null };
}

export async function readJsonBodyCapped<T>(event: H3Event, maxBytes: number): Promise<T> {
  const raw = await readRawBody(event, false).catch(() => undefined); // Buffer | undefined
  if (raw && raw.length > maxBytes)
    throw createError({ statusCode: 413, statusMessage: "Payload too large" });
  if (!raw || raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    return {} as T;
  }
}
