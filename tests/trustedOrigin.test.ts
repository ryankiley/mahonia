import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_ORIGIN } from "../shared/site";
import { refuseCrossSite, trustedOrigin } from "../server/utils/origin";

// The regression these pin down is a `Host` header deciding where an emailed
// credential points. A test that only checked "returns a string" would have
// passed against the bug, so every case here states which host it SENT and which
// origin it expects back.

// The only thing trustedOrigin reads off the event is the URL h3 derives from
// the request headers, so a fake carrying a hostile Host is enough — no server
// boot, no socket. Shape matches what h3's getRequestURL touches: the headers,
// and `path` (which it prefers to read via `req.originalUrl`, then `event.path`).
function eventWithHost(host: string, proto = "https") {
  return {
    path: "/api/auth/request",
    node: { req: { headers: { host, "x-forwarded-proto": proto }, url: "/api/auth/request" } },
  } as never;
}

const ENV_KEYS = ["MAHONIA_ORIGIN", "NODE_ENV", "VERCEL_ENV"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllEnvs();
});

describe("trustedOrigin — production", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  it("ignores a forged Host and answers with the canonical origin", () => {
    expect(trustedOrigin(eventWithHost("evil.example"))).toBe(CANONICAL_ORIGIN);
  });

  it("ignores a Host that merely LOOKS like ours", () => {
    expect(trustedOrigin(eventWithHost("mahonia.app.evil.example"))).toBe(CANONICAL_ORIGIN);
    expect(trustedOrigin(eventWithHost("mahonia-app.evil.example"))).toBe(CANONICAL_ORIGIN);
  });

  it("answers the same origin for the real host, so nothing changes in normal use", () => {
    expect(trustedOrigin(eventWithHost("mahonia.app"))).toBe(CANONICAL_ORIGIN);
  });

  it("treats VERCEL_ENV=production as production even when NODE_ENV disagrees", () => {
    process.env.NODE_ENV = "development";
    process.env.VERCEL_ENV = "production";
    expect(trustedOrigin(eventWithHost("evil.example"))).toBe(CANONICAL_ORIGIN);
  });
});

describe("trustedOrigin — MAHONIA_ORIGIN override", () => {
  it("wins over both the request and the canonical default", () => {
    process.env.NODE_ENV = "production";
    process.env.MAHONIA_ORIGIN = "https://gear.example.org";
    expect(trustedOrigin(eventWithHost("evil.example"))).toBe("https://gear.example.org");
  });

  it("normalizes a trailing slash and surrounding whitespace away", () => {
    process.env.NODE_ENV = "production";
    process.env.MAHONIA_ORIGIN = "  https://gear.example.org/  ";
    expect(trustedOrigin(eventWithHost("evil.example"))).toBe("https://gear.example.org");
  });

  it("drops a path — an origin is scheme + host, and a link is built by resolving against it", () => {
    process.env.NODE_ENV = "production";
    process.env.MAHONIA_ORIGIN = "https://gear.example.org/some/path";
    expect(trustedOrigin(eventWithHost("evil.example"))).toBe("https://gear.example.org");
  });

  it("falls back to the pinned origin rather than emitting junk when the value is malformed", () => {
    process.env.NODE_ENV = "production";
    for (const bad of ["", "   ", "not a url", "mahonia.app", "javascript:alert(1)", "ftp://x.example"]) {
      process.env.MAHONIA_ORIGIN = bad;
      expect(trustedOrigin(eventWithHost("evil.example"))).toBe(CANONICAL_ORIGIN);
    }
  });
});

describe("trustedOrigin — dev and previews keep deriving from the request", () => {
  it("uses the request origin in development, so localhost mails itself a working link", () => {
    process.env.NODE_ENV = "development";
    expect(trustedOrigin(eventWithHost("localhost:3000", "http"))).toBe("http://localhost:3000");
  });

  it("uses the request origin on a Vercel preview, whatever NODE_ENV says", () => {
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "preview";
    expect(trustedOrigin(eventWithHost("mahonia-git-branch.vercel.app"))).toBe(
      "https://mahonia-git-branch.vercel.app",
    );
  });
});

// The endpoints that START a session have no cookie for SameSite to withhold, so a
// form on another site could post a sign-in for its own account into a visitor's
// browser. Each case states the headers the browser would have sent.
describe("refuseCrossSite — only our own page may start a session", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });
  const post = (headers: Record<string, string>) =>
    ({
      path: "/api/auth/verify",
      node: { req: { headers: { host: "mahonia.app", "x-forwarded-proto": "https", ...headers }, url: "/api/auth/verify" } },
    }) as never;

  it("lets our own page through", () => {
    expect(() => refuseCrossSite(post({ origin: CANONICAL_ORIGIN, "sec-fetch-site": "same-origin" }))).not.toThrow();
  });

  it("refuses a form on another site, which names its own origin", () => {
    expect(() => refuseCrossSite(post({ origin: "https://evil.example" }))).toThrow();
    // a sandboxed frame or a no-referrer form post says "null", which is not us either
    expect(() => refuseCrossSite(post({ origin: "null" }))).toThrow();
    expect(() => refuseCrossSite(post({ "sec-fetch-site": "cross-site" }))).toThrow();
  });

  it("refuses a sibling site, which the browser calls same-site", () => {
    const sibling = post({ origin: "https://other.mahonia.app", "sec-fetch-site": "same-site" });
    expect(() => refuseCrossSite(sibling)).toThrow();
    // and anything a browser labels as other than our own page, whatever it claims
    expect(() => refuseCrossSite(post({ origin: CANONICAL_ORIGIN, "sec-fetch-site": "same-site" }))).toThrow();
  });

  it("lets through a page on another host that is serving this app", () => {
    // a www or deployment alias: the visitor's browser sends the Host it is on, and
    // its page's origin agrees with it. A page on evil.example agrees with neither.
    const alias = post({ host: "www.mahonia.app", origin: "https://www.mahonia.app", "sec-fetch-site": "same-origin" });
    expect(() => refuseCrossSite(alias)).not.toThrow();
    expect(() => refuseCrossSite(post({ host: "www.mahonia.app", origin: "https://evil.example" }))).toThrow();
  });

  it("lets through a request no browser page made", () => {
    // curl, a native client: no visitor's browser to sign in
    expect(() => refuseCrossSite(post({}))).not.toThrow();
  });
});
