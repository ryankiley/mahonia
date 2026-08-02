import { createError, getQuery, readRawBody, type H3Event } from "h3";

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

/**
 * One string query param, length-capped — the body-cap discipline applied to the
 * query string. A repeated param (?q=a&q=b) takes the first value; anything
 * absent or non-string becomes "". Shared by the search endpoints so the cap and
 * the array-collapse rule can't drift between them.
 */
export function readQueryString(event: H3Event, name: string, maxLength: number): string {
  const raw = getQuery(event)[name];
  return (Array.isArray(raw) ? raw[0] : raw ?? "").toString().slice(0, maxLength);
}
