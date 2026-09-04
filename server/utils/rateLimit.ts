import type { H3Event } from "h3";
import { createError, getRequestHeader, getRequestIP } from "h3";
import { sha256Hex } from "./tokens";

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

/**
 * The unit a rate limit should actually count: one CUSTOMER, not one address.
 *
 * Keying on the whole IP is right for IPv4, where an address is scarce and shared. It
 * is close to meaningless for IPv6: a residential connection is routed a /64, so a
 * script can bind a different source address per request and mint a fresh bucket every
 * time. Every limit here — sign-in links, reports, and the anonymous feedback endpoint
 * that opens PUBLIC issues — was bypassable that way by anyone with an ordinary
 * dual-stack connection.
 *
 * So IPv6 collapses to its /64, which is the smallest block an ISP hands to a single
 * subscriber. IPv4 is kept whole (a /64 has no meaning there, and truncating would
 * bucket a whole carrier-grade NAT together). IPv4-mapped v6 is unwrapped first, or
 * "::ffff:1.2.3.4" would be scoped as though it were v6.
 *
 * Cost: two devices behind one home router already shared a bucket on IPv4 and now do
 * on IPv6 too. That is the intended reading of "one client".
 */
export function rateLimitScope(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip; // IPv4, or anything else we can't parse — as-is
  const bare = ip.split("%")[0]!; // drop a scope id ("fe80::1%eth0")
  const halves = bare.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  // expand the "::" run so the first four hextets are the real ones
  const gap = halves.length > 1 ? Math.max(0, 8 - head.length - tail.length) : 0;
  const full = [...head, ...Array<string>(gap).fill("0"), ...tail];
  const prefix = full
    .slice(0, 4)
    .map((h) => (h || "0").toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":");
  return `${prefix}::/64`;
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
 * Whether a SHARED KV store is configured — the same two env vars
 * nuxt.config.ts tests when it picks a driver, so the two can't disagree.
 *
 * One answer, two very different consequences. Rate limiting keeps serving
 * without it, because a limit counted per instance is degraded rather than
 * broken and refusing would take the whole site down over a throttle (useKv
 * below warns once instead). Passkeys REFUSE without it, because a ceremony
 * split across two instances can't complete — see requirePasskeysConfigured.
 */
export function sharedKvConfigured(): boolean {
  if (process.env.NODE_ENV !== "production") return true; // dev's in-memory KV is one process
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// Warn ONCE per instance, not once per request: the fallback is a standing
// condition, and a line per request would bury the incident it's reporting.
let warnedAboutStore = false;

/**
 * The shared KV store (Upstash in prod, in-memory in dev — see nuxt.config.ts),
 * as the narrow KvStorage surface. Confines the one unavoidable `as unknown as`
 * cast over Nitro's loosely-typed `useStorage` to a single auditable spot, instead
 * of repeating it at every call site. (`useStorage` is a Nitro auto-import.)
 *
 * AND SAYS SO WHEN THE STORE ISN'T SHARED. Without Upstash, nuxt.config falls
 * back to the in-memory driver and every budget below silently becomes per warm
 * serverless instance — a number Vercel scales with load. Tolerating that is a
 * deliberate choice (see sharedKvConfigured); tolerating it in silence was
 * not. Nothing in a response differs, so a log line is the only place this can
 * surface, and the endpoints it protects are the ones that most need it:
 * `feedback` opens PUBLIC issues anonymously, `auth-request` sends mail to
 * addresses the caller names, `catalog-correct` writes the catalog everyone reads.
 */
export function useKv(): KvStorage {
  if (!warnedAboutStore && !sharedKvConfigured()) {
    warnedAboutStore = true;
    console.error(
      "[rate-limit] no shared KV configured (KV_REST_API_URL / KV_REST_API_TOKEN) — every budget is now per serverless instance, not global",
    );
  }
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
interface ReportTally {
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

// Per-IP request budgets, all on a fixed 1-minute window — the whole throttle
// policy in one reviewable table (endpoints used to hardcode their own numbers).
const WINDOW_MS = 60_000;
const RATE_LIMITS = {
  // editor write path — every keystroke batch lands here, so it's the roomiest
  "mutate": 300,
  "create": 30,
  "import": 20,
  // editor read/poll paths
  "snapshots": 120,
  "publishget": 120,
  // the live-sync editor poll + full-snapshot fetch — hit ~20/min per open editor,
  // so a roomy budget; gates the unauthenticated DB lookup any bearer string triggers
  "poll": 180,
  // owner-only, rare: whole-list delete + edit-token rotation
  "delete": 20,
  "rotate": 20,
  // public read views (/l, /s) — edge-cached, so origin hits are rare; a generous
  // per-IP cap bounds cache-busted floods (each uncached /l hit also bumps view_count)
  "public-read": 120,
  // heavier / abuse-prone writes
  "publish": 20,
  "restore": 30,
  "report": 10,
  // catalog: autocomplete search is per-keystroke; corrections are rare writes
  "catalog-search": 240,
  "catalog-use": 120,
  "catalog-changes": 60,
  "catalog-correct": 20,
  // trail-link favicon lookup — the ONE endpoint that fetches a caller-named third-party
  // host, so it's the tightest public budget here. A real editor asks once per link it
  // adds, and the per-host cache means most asks never leave the origin at all.
  "trail-favicon": 30,
  // vault: capture is a debounced background write from an open editor (one per few
  // seconds at worst); search is per-keystroke, like the catalog's, so it carries the
  // same order of budget. Capture and a hand-typed add (gear-write) are the two
  // endpoints that can MINT a gear, so between them these budgets cap how fast rows
  // can be conjured from nothing. Minting itself is idempotent per account — one
  // gear per user, enforced by the index — so what they bound is the writes.
  "vault-capture": 60,
  "vault-search": 240,
  "vault-read": 120,
  "vault-write": 60,
  // --- the optional account layer ---------------------------------------------
  // Sign-in is the tight one: it sends mail, and the same action is limited BOTH
  // per-IP and per-email (see rateLimitSubject) because neither alone stops both
  // a sprayer and a mailbomber.
  // Anonymous and it writes to a PUBLIC issue tracker, so this is the tightest
  // bucket in the app — the same figure as sign-in, for the same reason: there is
  // no account gate in front of it, and each request has an outward-facing effect.
  "feedback": 5,
  "auth-request": 5,
  "auth-verify": 20,
  "auth-me": 120,
  "passkey": 30,
  // Its own bucket, far tighter than "passkey": every other passkey route needs a
  // session first, so they're gated by already having an account. This one is
  // reachable by anyone and writes a row in `users`.
  "passkey-signup": 5,
  "account": 30,
  "list-claim": 60,
  // the admin gate itself (see requireAdmin) — throttled against brute force
  "admin": 30,
} as const satisfies Record<string, number>;

export type RateLimitAction = keyof typeof RATE_LIMITS;

/**
 * Per-IP rate limit for a public mutating endpoint, with the budget looked up
 * from RATE_LIMITS. Backed by Nitro's `useStorage("kv")` — Upstash Redis in prod
 * (shared across every serverless instance), in-memory in dev. Throws 429 once
 * the window's limit is exceeded.
 */
export async function rateLimit(event: H3Event, action: RateLimitAction): Promise<void> {
  const ip = getClientIp(event) || "unknown";
  // scoped, not raw — see rateLimitScope: a raw v6 address is one of 2^64 a single
  // subscriber can send from, so the budget has to be per /64
  await enforce(`rl:${action}:${rateLimitScope(ip)}`, action);
}

/** The shared tail of both limiters: one consume, one 429 — a single place for
 *  the status line, so the two keyings can't drift in how they refuse. */
async function enforce(key: string, action: RateLimitAction): Promise<void> {
  const over = await consumeRateLimit(useKv(), key, RATE_LIMITS[action], WINDOW_MS, Date.now());
  if (over) throw createError({ statusCode: 429, statusMessage: "Too many requests" });
}

/**
 * Limit by a SUBJECT rather than by IP — the same budget, keyed on who the request
 * is about instead of where it came from.
 *
 * Exists for sign-in: a per-IP limit stops one machine spraying many addresses,
 * but not a distributed pool mailbombing one person's inbox. The subject is hashed
 * so the KV store never holds a raw email.
 */
export async function rateLimitSubject(action: RateLimitAction, subject: string): Promise<void> {
  await enforce(`rl:${action}:s:${sha256Hex(subject)}`, action);
}
