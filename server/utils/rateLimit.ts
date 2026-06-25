import type { H3Event } from "h3";
import { createError, getHeader, getRequestIP } from "h3";

/** Reject oversized request bodies before parsing (defense-in-depth vs DoS). */
export function assertMaxBody(event: H3Event, maxBytes: number) {
  const len = Number(getHeader(event, "content-length") || 0);
  if (len > maxBytes) throw createError({ statusCode: 413, statusMessage: "Payload too large" });
}

// Interim per-IP token bucket (single-instance dev). Production should swap this
// for an Upstash/Redis counter so the limit holds across serverless instances —
// tracked as part of the planned rate-limiting phase.
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(event: H3Event, action: string, limit: number, windowMs: number) {
  const ip = getRequestIP(event, { xForwardedFor: true }) || "unknown";
  const key = `${action}:${ip}`;
  const now = Date.now();

  // opportunistic prune so the map can't grow unbounded
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }

  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) throw createError({ statusCode: 429, statusMessage: "Too many requests" });
}
