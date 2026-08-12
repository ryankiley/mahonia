import { createError, readRawBody, setHeader, type H3Event } from "h3";

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
