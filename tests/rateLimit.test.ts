import type { H3Event } from "h3";
import { describe, expect, it } from "vitest";
import {
  consumeRateLimit,
  rateLimitScope,
  getClientIp,
  tallyDistinctReport,
  type KvStorage,
} from "../server/utils/rateLimit";

// A Map-backed fake of the KV store. This also mirrors the prod fix itself: one
// shared store that every "instance" reads/writes, vs the old per-process Map.
function fakeKv(): KvStorage {
  const map = new Map<string, unknown>();
  return {
    getItem: async <T>(key: string) => (map.has(key) ? (map.get(key) as T) : null),
    setItem: async <T>(key: string, value: T) => {
      map.set(key, value);
    },
  };
}

// Minimal duck-typed H3 event: getClientIp only reads request headers + the
// socket address through h3's accessors (event.node.req.headers / socket).
function fakeEvent(headers: Record<string, string>, remoteAddress = "203.0.113.7"): H3Event {
  return {
    node: { req: { headers, socket: { remoteAddress } } },
    context: {},
  } as unknown as H3Event;
}

describe("getClientIp — trusted-header IP derivation (anti-spoof)", () => {
  it("prefers Vercel's header and IGNORES a spoofed X-Forwarded-For", () => {
    const event = fakeEvent({
      "x-forwarded-for": "1.2.3.4", // attacker-supplied — must be ignored
      "x-vercel-forwarded-for": "9.9.9.9",
    });
    expect(getClientIp(event)).toBe("9.9.9.9");
  });

  it("does NOT trust a lone client X-Forwarded-For (falls back to the socket)", () => {
    // The old code returned "1.2.3.4" here — that was the bucket-bypass hole.
    const event = fakeEvent({ "x-forwarded-for": "1.2.3.4" }, "203.0.113.7");
    expect(getClientIp(event)).toBe("203.0.113.7");
  });

  it("uses x-real-ip when present and there's no Vercel header", () => {
    expect(getClientIp(fakeEvent({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
  });

  it("takes the first hop of a multi-value Vercel header, trimmed", () => {
    expect(getClientIp(fakeEvent({ "x-vercel-forwarded-for": "9.9.9.9, 10.0.0.5" }))).toBe("9.9.9.9");
  });

  it("falls back to the socket address when no trusted header is set", () => {
    expect(getClientIp(fakeEvent({}, "198.51.100.2"))).toBe("198.51.100.2");
  });
});

describe("consumeRateLimit — shared-store fixed-window counter", () => {
  it("allows up to the limit, then reports over", async () => {
    const kv = fakeKv();
    const hit = () => consumeRateLimit(kv, "rl:create:ip", 2, 60_000, 0);
    expect(await hit()).toBe(false); // 1st
    expect(await hit()).toBe(false); // 2nd (== limit)
    expect(await hit()).toBe(true); // 3rd (over)
  });

  it("resets once the window elapses", async () => {
    const kv = fakeKv();
    expect(await consumeRateLimit(kv, "k", 1, 1_000, 0)).toBe(false); // count 1
    expect(await consumeRateLimit(kv, "k", 1, 1_000, 500)).toBe(true); // count 2, over, same window
    expect(await consumeRateLimit(kv, "k", 1, 1_000, 1_000)).toBe(false); // window rolled over → fresh
  });

  it("shares one counter across callers (the per-instance-Map fix)", async () => {
    const kv = fakeKv(); // one store, like Upstash shared across serverless instances
    for (let i = 0; i < 3; i++) expect(await consumeRateLimit(kv, "k", 3, 60_000, 0)).toBe(false);
    expect(await consumeRateLimit(kv, "k", 3, 60_000, 0)).toBe(true); // 4th over — count survived across calls
    // an independent key (different action/IP) keeps an independent budget
    expect(await consumeRateLimit(kv, "other", 3, 60_000, 0)).toBe(false);
  });

  it("sets a TTL bounded by the remaining window", async () => {
    const ttls: number[] = [];
    const kv: KvStorage = {
      getItem: async <T>() => null as T | null,
      setItem: async <T>(_k: string, _v: T, opts?: { ttl?: number }) => {
        if (opts?.ttl !== undefined) ttls.push(opts.ttl);
      },
    };
    await consumeRateLimit(kv, "k", 5, 60_000, 0);
    expect(ttls[0]).toBe(60); // ceil(60000 / 1000)
  });
});

describe("tallyDistinctReport — distinct-reporter threshold (IP-deduped)", () => {
  const W = 60_000;
  it("only reaches the threshold with DISTINCT reporters", async () => {
    const kv = fakeKv();
    const r = (ip: string) => tallyDistinctReport(kv, "slug", ip, 3, W);
    expect(await r("ipA")).toEqual({ distinct: 1, reached: false });
    expect(await r("ipB")).toEqual({ distinct: 2, reached: false });
    expect(await r("ipC")).toEqual({ distinct: 3, reached: true });
  });

  it("ignores the same reporter re-reporting (one actor can't self-flag)", async () => {
    const kv = fakeKv();
    const r = (ip: string) => tallyDistinctReport(kv, "slug", ip, 3, W);
    for (let i = 0; i < 10; i++) expect((await r("ipA")).reached).toBe(false);
    expect((await r("ipA")).distinct).toBe(1); // still just one distinct reporter
  });

  it("keeps separate tallies per slug", async () => {
    const kv = fakeKv();
    await tallyDistinctReport(kv, "one", "ipA", 2, W);
    const other = await tallyDistinctReport(kv, "two", "ipA", 2, W);
    expect(other.distinct).toBe(1); // "two" didn't inherit "one"'s reporter
  });
});

// A limit is only as good as the thing it counts. Keying on a whole IPv6 address
// counted ADDRESSES, and a residential connection is routed a /64 — so any limit here
// (sign-in links, reports, and the anonymous endpoint that opens public GitHub issues)
// could be walked around by binding a new source address per request.
describe("rateLimitScope", () => {
  it("keeps an IPv4 address whole", () => {
    // no /64 to speak of, and truncating would bucket a whole carrier NAT together
    expect(rateLimitScope("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitScope("10.0.0.1")).toBe("10.0.0.1");
  });

  it("collapses every address in one /64 to a single bucket", () => {
    const a = rateLimitScope("2001:db8:1234:5678:0:0:0:1");
    const b = rateLimitScope("2001:db8:1234:5678:ffff:ffff:ffff:ffff");
    const c = rateLimitScope("2001:db8:1234:5678::dead:beef");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("still separates DIFFERENT /64s", () => {
    expect(rateLimitScope("2001:db8:1234:5678::1"))
      .not.toBe(rateLimitScope("2001:db8:1234:9999::1"));
  });

  it("expands a compressed run so the prefix is the real one", () => {
    // "2001:db8::1" is 2001:0db8:0000:0000:...:0001 — its /64 is 2001:db8:0:0
    expect(rateLimitScope("2001:db8::1")).toBe(rateLimitScope("2001:db8:0:0:5:6:7:8"));
    expect(rateLimitScope("::1")).toBe(rateLimitScope("0:0:0:0::9"));
  });

  it("unwraps an IPv4-mapped address rather than scoping it as v6", () => {
    expect(rateLimitScope("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("ignores a scope id", () => {
    expect(rateLimitScope("fe80::1%eth0")).toBe(rateLimitScope("fe80::2"));
  });
});
