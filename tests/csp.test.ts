import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The site talks to exactly one host that isn't itself, and this file is the thing that
// keeps it that way.
//
// Until the basemap, every CSP directive was same-origin, which is what made "your GPX
// never leaves your browser" a fact rather than a promise. Adding a map spends that
// property, and the whole design of Part 3 was chosen to spend as little of it as
// possible: raster tiles are <img>, so the cost is ONE token in ONE directive.
//
// The risk isn't the token. It's the next person — reaching for a geocoder, a font, an
// analytics pixel, a CDN — finding a third-party host already in the file and reading it
// as permission. So these assertions are deliberately about the SHAPE of the policy
// rather than its exact text: one host, in img-src, and nowhere else.

const ROOT = new URL("..", import.meta.url).pathname;
const config = readFileSync(`${ROOT}nuxt.config.ts`, "utf8");
const routeMap = readFileSync(`${ROOT}app/components/RouteMap.client.vue`, "utf8");

/** The literal directive strings, with TILE_ORIGIN interpolated as the build does. */
const directives = (() => {
  const origin = config.match(/const TILE_ORIGIN = "([^"]+)"/)?.[1];
  expect(origin, "TILE_ORIGIN must be a single constant").toBeTruthy();
  const block = config.slice(config.indexOf("const CSP = ["), config.indexOf('].join("; ")'));
  const found = [...block.matchAll(/["`]([a-z-]+-src|[a-z-]+-ancestors|[a-z-]+-uri|form-action)([^"`]*)["`]/g)];
  expect(found.length, "parsed no directives — did the CSP block move?").toBeGreaterThan(8);
  return new Map(found.map((m) => [m[1]!, m[2]!.replace("${TILE_ORIGIN}", origin!).trim()]));
})();

const TILE_ORIGIN = config.match(/const TILE_ORIGIN = "([^"]+)"/)![1]!;

describe("the policy still says same-origin everywhere it matters", () => {
  it("connect-src is 'self' — no fetch, XHR, EventSource or WebSocket leaves the app", () => {
    // The load-bearing half. This is what makes an uploaded GPX unable to go anywhere,
    // and it is why place search has to be proxied through our own server instead of
    // being called from the browser.
    expect(directives.get("connect-src")).toBe("'self'");
  });

  it("script-src admits no host, because the edit token is readable from the page", () => {
    // A list's edit capability lives in the URL fragment. Any third-party script in the
    // page can read location.hash — so a CDN <script> is a capability leak, not a
    // preference. This is the assertion that says Leaflet must stay bundled.
    expect(directives.get("script-src")).toBe("'self' 'unsafe-inline'");
  });

  it("nothing else gained a host either", () => {
    for (const name of ["font-src", "style-src", "worker-src", "manifest-src", "default-src", "form-action"]) {
      expect(directives.get(name), name).not.toMatch(/https?:/);
    }
  });
});

describe("the basemap costs exactly one token", () => {
  it("img-src gained one host and it is the tile origin", () => {
    const img = directives.get("img-src")!;
    expect(img).toContain(TILE_ORIGIN);
    expect(img.match(/https?:\/\/\S+/g)).toHaveLength(1);
  });

  it("the whole policy contains exactly one external host, in one directive", () => {
    const withHost = [...directives].filter(([, v]) => /https?:\/\//.test(v)).map(([k]) => k);
    expect(withHost).toEqual(["img-src"]);
  });

  it("the tile origin is a bare origin — no path, no key, no query", () => {
    // A key in the URL would be a public key. Part of why this provider was chosen is
    // that there is no key to put here in the first place.
    expect(TILE_ORIGIN).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    expect(TILE_ORIGIN).not.toMatch(/[?=]/);
  });

  it("the map reads the host from runtimeConfig, so URL and policy cannot drift", () => {
    expect(config).toMatch(/tileOrigin: TILE_ORIGIN/);
    expect(routeMap).toMatch(/tileOrigin/);
    // and doesn't hardcode a second copy of it
    expect(routeMap).not.toContain(TILE_ORIGIN);
  });
});

describe("what using someone else's tiles obliges", () => {
  it("sends a referrer, or the tiles are refused", () => {
    // The site sets Referrer-Policy: no-referrer. Both candidate providers authenticate
    // or enforce their usage policy by Referer, and an <img> never sends Origin either —
    // so without this the map is silently either broken or in breach.
    expect(routeMap).toMatch(/referrerPolicy:\s*"origin"/);
  });

  it("caps maxZoom where the elevation data actually stops", () => {
    // Past this the tiles are enlarging pixels rather than showing more ground, and most
    // tiles in a session come from zooming in — so the cap is both honest and cheap.
    expect(routeMap).toMatch(/maxZoom:\s*16\b/);
  });

  it("keeps attribution, which is a licence requirement and not decoration", () => {
    expect(routeMap).toMatch(/attribution:/);
    expect(routeMap).toMatch(/Esri/);
    // …and never styles it away
    expect(routeMap).not.toMatch(/\.leaflet-control-attribution[^{]*\{[^}]*display:\s*none/);
  });

  it("uses the ArcGIS axis order, not the OSM one", () => {
    // This service numbers tiles {z}/{y}/{x}. Swapped, it still returns 200s — it just
    // returns tiles of somewhere else, which no error handler would ever catch.
    expect(routeMap).toMatch(/tile\/\{z\}\/\{y\}\/\{x\}/);
  });

  it("never prefetches — the offline story is the fallback, not a tile cache", () => {
    expect(routeMap).not.toMatch(/prefetch|preload|bulk/i);
  });

  it("the terms tripwire sits next to the thing it governs", () => {
    // Free WITH ATTRIBUTION, from an unkeyed endpoint that could close at any time. The
    // note has to be where someone changing the provider will read it.
    expect(config).toMatch(/TRIPWIRE/);
    expect(config.slice(config.indexOf("TRIPWIRE"), config.indexOf("const TILE_ORIGIN"))).toMatch(
      /attribution/i,
    );
  });
});
