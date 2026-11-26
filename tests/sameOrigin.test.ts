import { describe, expect, it } from "vitest";
import sameOrigin from "../server/middleware/sameOrigin";
import { makeEvent } from "./helpers/http";

// One rule for every write to /api: it comes from our own page, or from no page at
// all. Each case states the method, the path and the headers a browser (or not a
// browser) would have sent. makeEvent's host is mahonia.test over plain http, and
// outside production the trusted origin is the request's own.
const OURS = "http://mahonia.test";
const hit = (method: string, url: string, headers: Record<string, string> = {}) =>
  sameOrigin(makeEvent(url, { method, headers }));

describe("sameOrigin — who may write to the API", () => {
  it("refuses a page on another site, whatever it is posting to", () => {
    for (const url of ["/api/auth/verify", "/api/vault/items", "/api/lists/create", "/api/feedback"])
      expect(() => hit("POST", url, { origin: "https://evil.example" })).toThrow(/Origin not allowed/);
    // every method that changes something, not only POST
    for (const method of ["PUT", "PATCH", "DELETE"])
      expect(() => hit(method, "/api/edit/list", { origin: "https://evil.example" })).toThrow();
    // a form post under no-referrer names no origin but "null"; the browser's own
    // label for the request settles one that names ours and isn't
    expect(() => hit("POST", "/api/auth/signout", { origin: "null" })).toThrow();
    expect(() => hit("POST", "/api/auth/signout", { origin: OURS, "sec-fetch-site": "cross-site" })).toThrow();
  });

  it("lets our own page write", () => {
    expect(() => hit("POST", "/api/vault/items", { origin: OURS, "sec-fetch-site": "same-origin" })).not.toThrow();
  });

  it("lets our own page write when its origin goes unnamed", () => {
    // The page-hide beacon that saves gear to My Gear, in Firefox, and any plain
    // form post: not a CORS fetch, so under this site's no-referrer policy the
    // browser names the origin as "null" even though the page is ours. The
    // browser's own label says whose it is, and that label is what decides.
    expect(() =>
      hit("POST", "/api/vault/capture", { origin: "null", "sec-fetch-site": "same-origin" }),
    ).not.toThrow();
    // from another site the same unnamed origin comes labelled as what it is
    expect(() => hit("POST", "/api/vault/capture", { origin: "null", "sec-fetch-site": "cross-site" })).toThrow();
    expect(() => hit("POST", "/api/vault/capture", { origin: "null", "sec-fetch-site": "same-site" })).toThrow();
    // and with no label to go by, an origin that names nobody is not ours
    expect(() => hit("POST", "/api/vault/capture", { origin: "null" })).toThrow();
  });

  it("goes by the origin for a browser too old to label its requests", () => {
    expect(() => hit("POST", "/api/vault/items", { origin: OURS })).not.toThrow();
    expect(() => hit("POST", "/api/vault/items", { origin: "https://evil.example" })).toThrow();
  });

  it("lets through what no browser page sent", () => {
    // the native app, curl, another server: no visitor's cookies to ride on
    expect(() => hit("POST", "/api/edit/mutate")).not.toThrow();
  });

  it("leaves reads alone", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"])
      expect(() => hit(method, "/api/s/C0DE00000001", { origin: "https://evil.example" })).not.toThrow();
  });

  it("is not the rule for the endpoints other origins are meant to call", () => {
    // bearer-only, never a cookie: cors.ts opens these and /mcp checks for itself
    for (const url of ["/mcp", "/token", "/register", "/revoke"])
      expect(() => hit("POST", url, { origin: "https://claude.ai" })).not.toThrow();
  });
});
