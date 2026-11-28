// What using someone else's tiles obliges, as the mounted map does it. The policy half
// (one third-party host, in img-src and nowhere else) is tests/csp.test.ts; this is the
// map keeping to it and to the provider's terms.
//
// Leaflet draws its tiles as real <img> elements, so a map with no layout still asks for
// the one tile under its centre, and that one tile says where it came from and how.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount } from "@vue/test-utils";
import { TILE_ORIGIN } from "~~/config/security";
import { mountRouteMap } from "./helpers/routeMap";

// a short walk, so framing it zooms the map as far in as it is allowed to go, and two
// points, so the tile under its centre is plain arithmetic
const ROUTE = [
  { lat: 45.3736, lon: -121.696 },
  { lat: 45.378, lon: -121.69 },
];

enableAutoUnmount(afterEach);

/** Mount the map and wait for the tile under its centre. */
async function open() {
  const { root } = await mountRouteMap({}, { points: ROUTE, ready: (map) => map.querySelector("img.leaflet-tile") !== null });
  return {
    tiles: () => [...root.querySelectorAll<HTMLImageElement>("img.leaflet-tile")],
    attribution: () => root.querySelector(".leaflet-control-attribution")?.textContent ?? "",
    canZoomIn: () => !root.querySelector(".leaflet-control-zoom-in")!.classList.contains("leaflet-disabled"),
  };
}

/** The OSM tile numbering ({z}/{x}/{y}) of a point. */
function osmTile(lat: number, lon: number, z: number): [number, number] {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [Math.floor(x), Math.floor(y)];
}

describe("the route map's tiles", () => {
  // The site sends Referrer-Policy: no-referrer, and the provider enforces its usage
  // policy by Referer (an <img> never sends Origin), so without this the tiles are
  // refused or the map is in breach.
  it("send the site's origin as a referrer", async () => {
    const map = await open();
    for (const tile of map.tiles()) expect(tile.getAttribute("referrerpolicy")).toBe("origin");
  });

  // The provider numbers tiles {z}/{x}/{y}; the documented fallback numbers them
  // {z}/{y}/{x}. Swapped, either still answers, with tiles of somewhere else. And the
  // host is the one the policy allows, read from the same constant, so the two can't drift.
  it("come from the allowed host, numbered the OSM way", async () => {
    const map = await open();
    const [x, y] = osmTile((ROUTE[0]!.lat + ROUTE[1]!.lat) / 2, (ROUTE[0]!.lon + ROUTE[1]!.lon) / 2, 17);
    expect(map.tiles()[0]!.getAttribute("src")).toBe(`${TILE_ORIGIN}/17/${x}/${y}.png`);
  });

  // OpenTopoMap's own ceiling. Most tiles in a session come from zooming in, so this is
  // the cheapest way to stay a light user of infrastructure that is donated, not sold.
  it("stop at zoom 17", async () => {
    const map = await open();
    expect(new URL(map.tiles()[0]!.src).pathname.split("/")[1]).toBe("17");
    expect(map.canZoomIn()).toBe(false);
  });

  // CC-BY-SA: a condition of use, not a courtesy.
  it("credit OpenStreetMap and OpenTopoMap", async () => {
    const map = await open();
    expect(map.attribution()).toContain("© OpenStreetMap contributors");
    expect(map.attribution()).toContain("© OpenTopoMap (CC-BY-SA)");
  });

  // The offline story is the fallback, not a tile cache: the map asks for the tiles in
  // view and has the browser fetch none ahead.
  it("are asked for only as they come into view", async () => {
    const map = await open();
    expect(map.tiles()).toHaveLength(1);
    const ahead = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"], link[rel="preload"]')];
    expect(ahead.filter((l) => l.href.startsWith(TILE_ORIGIN))).toEqual([]);
  });
});
