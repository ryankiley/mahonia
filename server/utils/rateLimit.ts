import type { H3Event } from "h3";
import { createError, getHeader, getRequestHeader, getRequestIP } from "h3";

/** Reject oversized request bodies before parsing (defense-in-depth vs DoS). */
export function assertMaxBody(event: H3Event, maxBytes: number) {
  const len = Number(getHeader(event, "content-length") || 0);
  if (len > maxBytes) throw createError({ statusCode: 413, statusMessage: "Payload too large" });
}

/**
 * Resolve the client IP for rate limiting.
 *
 * NOT `getRequestIP(event, { xForwardedFor: true })`: that returns the LEFTMOST
 * `X-Forwarded-For` entry, which is client-supplied and trivially spoofable. A
 * client can rotate the header to land in a fresh bucket on every request
 * (defeating the limit entirely), or pin a victim's IP to get the victim limited.
 *
 * This app deploys on Vercel, so trust only the headers Vercel's edge sets — and
 * which it overwrites on any client-supplied copy:
 *   1. `x-vercel-forwarded-for` — Vercel's canonical real-client-IP header.
 *   2. `x-real-ip` — also set by Vercel's proxy.
 *   3. socket remote address (bare `getRequestIP`, no XFF) — last resort, never
 *      client-controlled; this is what dev/PGlite (no edge in front) falls to.
 *
 * Residual: a request sent straight to the `*.vercel.app` origin (bypassing the
 * edge) could forge these headers, but that's a pre-existing platform exposure
 * and out of scope here — the fix that matters is no longer trusting the
 * leftmost XFF. Returns undefined when nothing resolves so callers fall back.
 */
export function getClientIp(event: H3Event): string | undefined {
  const vercel = getRequestHeader(event, "x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0]!.trim();
  const real = getRequestHeader(event, "x-real-ip");
  if (real) return real.trim();
  return getRequestIP(event);
}

type Bucket = { count: number; resetAt: number };

// The subset of Nitro's `useStorage("kv")` API the limiter touches. Prod binds
// it to Upstash Redis, dev to an in-memory driver (both in nuxt.config.ts);
// tests inject a Map-backed fake.
export interface KvStorage {
  getItem: <T>(key: string) => Promise<T | null>;
  setItem: <T>(key: string, value: T, opts?: { ttl?: number }) => Promise<void>;
}

/**
 * The shared KV store (Upstash in prod, in-memory in dev — see nuxt.config.ts),
 * as the narrow KvStorage surface. Confines the one unavoidable `as unknown as`
 * cast over Nitro's loosely-typed `useStorage` to a single auditable spot, instead
 * of repeating it at every call site. (`useStorage` is a Nitro auto-import.)
 */
export function useKv(): KvStorage {
  return useStorage("kv") as unknown as KvStorage;
}

/**
 * Fixed-window counter against a SHARED store. Returns true when the request is
 * over the limit. Clock + storage are injected so it's pure and unit-testable —
 * and, crucially, instance-independent: backing this with one shared Upstash
 * counter (not a per-process Map) is what makes the limit hold globally across
 * Vercel's serverless instances instead of per-instance.
 *
 * Concurrency: get→increment→set is not an atomic Redis INCR, so two requests
 * racing at the boundary can each read the same count and both pass (±1 over the
 * limit). Acceptable for these coarse per-IP budgets.
 */
export async function consumeRateLimit(
  storage: KvStorage,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<boolean> {
  const existing = await storage.getItem<Bucket>(key);
  const bucket: Bucket =
    !existing || existing.resetAt <= now
      ? { count: 1, resetAt: now + windowMs }
      : { count: existing.count + 1, resetAt: existing.resetAt };
  // TTL bounds the key to the remaining window so expired windows self-evict on
  // Upstash and the in-memory dev driver can't grow unbounded.
  const ttl = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  await storage.setItem(key, bucket, { ttl });
  return bucket.count > limit;
}

// A per-slug set of distinct reporter fingerprints (hashed IPs), held in the
// same shared KV store as the rate limiter.
export interface ReportTally {
  ips: string[];
}

/**
 * Record a distinct reporter for `slug` and report whether the distinct-reporter
 * threshold has been reached. IP-deduped: the same reporter re-reporting never
 * moves the count, so one actor can't flag a list alone. Pure/injectable like
 * consumeRateLimit so it's unit-testable. TTL bounds the tally to `windowMs` from
 * the last report, so a stale, rarely-reported list decays instead of latching.
 */
export async function tallyDistinctReport(
  storage: KvStorage,
  slug: string,
  reporterHash: string,
  threshold: number,
  windowMs: number,
): Promise<{ distinct: number; reached: boolean }> {
  const key = `report:${slug}`;
  const existing = await storage.getItem<ReportTally>(key);
  const prior = existing?.ips ?? [];
  const ips = prior.includes(reporterHash) ? prior : [...prior, reporterHash];
  // bound the stored set — once we're past the threshold the exact members no
  // longer matter, so a rotating attacker can't grow the value unbounded.
  const cap = Math.max(threshold * 4, 16);
  const capped = ips.length > cap ? ips.slice(0, cap) : ips;
  const ttl = Math.max(1, Math.ceil(windowMs / 1000));
  await storage.setItem(key, { ips: capped }, { ttl });
  return { distinct: capped.length, reached: capped.length >= threshold };
}

/** Clear a slug's report tally (admin restore — so a restored list can't instantly re-flag). */
export async function clearReportTally(storage: KvStorage, slug: string): Promise<void> {
  await storage.setItem(`report:${slug}`, { ips: [] }, { ttl: 1 });
}

/**
 * Per-IP rate limit for a public mutating endpoint. Backed by Nitro's
 * `useStorage("kv")` — Upstash Redis in prod (shared across every serverless
 * instance), in-memory in dev. Throws 429 once the window's limit is exceeded.
 */
export async function rateLimit(
  event: H3Event,
  action: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const ip = getClientIp(event) || "unknown";
  const over = await consumeRateLimit(useKv(), `rl:${action}:${ip}`, limit, windowMs, Date.now());
  if (over) throw createError({ statusCode: 429, statusMessage: "Too many requests" });
}
