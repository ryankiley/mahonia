// @vitest-environment nuxt
//
// The map draws the whole route, whether or not any of it has been planned.
//
// The legs are cut from the itinerary, so a route with no days had no legs — and the map
// drew nothing but its end pins on a sheet of contours. A file imported a minute ago, the
// one moment a person most wants to see where the line goes, was the moment the map had
// the least to show. The same held for the ground past the last planned day. So the
// whole track is drawn first as neutral ground, and each day's leg lands over its stretch.
//
// Leaflet renders to SVG, which is what makes this checkable in a DOM with no layout:
// every line is a real <path> with the class renderLegs gave it. Nothing here asserts a
// coordinate — happy-dom has no geometry, so the paths carry none — only that the marks
// exist, in the order the layering depends on.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import RouteMap from "~/components/RouteMap.client.vue";
import { encodePolyline } from "~~/shared/polyline";

// a short walk north-east, ~1.5 km, so a day can cover part of it
const geometry = encodePolyline([
  { lat: 45.3736, lon: -121.696 },
  { lat: 45.378, lon: -121.69 },
  { lat: 45.382, lon: -121.684 },
  { lat: 45.386, lon: -121.678 },
]);

beforeAll(() => {
  // draw() watches the host's box; happy-dom has no ResizeObserver to hand it
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

/** Mount, then wait for the Leaflet chunk draw() imports and the tick it draws on. */
async function open(dayDistancesM: number[]) {
  wrapper = mount(RouteMap, { props: { geometry, dayDistancesM }, attachTo: document.body });
  // draw() is async: a nextTick, then `await import("leaflet")`, then the lines
  for (let i = 0; i < 20 && !wrapper.element.querySelector(".leaflet-overlay-pane path"); i++) {
    await new Promise((r) => setTimeout(r, 25));
    await nextTick();
  }
  const classes = () =>
    [...wrapper!.element.querySelectorAll(".leaflet-overlay-pane path")].map((p) => p.getAttribute("class") ?? "");
  return { classes, wrapper: wrapper! };
}

describe("the route on the map", () => {
  // The report: an imported route drew nothing on the map until a day was planned.
  it("is drawn as ground when no day has been planned", async () => {
    const t = await open([]);
    const paths = t.classes();
    expect(paths.some((c) => c.includes("routemap__ground"))).toBe(true);
    expect(paths.some((c) => c.includes("routemap__leg"))).toBe(false);
  });

  // With a plan, the ground is still there UNDER the day — drawn first, so the coloured
  // leg lands on top of it and what stays visible is what nobody has claimed.
  it("keeps the ground under the day legs, ground first", async () => {
    const t = await open([800]);
    const paths = t.classes();
    const ground = paths.findIndex((c) => c.includes("routemap__ground"));
    const leg = paths.findIndex((c) => c.includes("routemap__leg"));
    expect(ground).toBeGreaterThanOrEqual(0);
    expect(leg).toBeGreaterThan(ground);
  });

  // Planning after the fact: the itinerary changing rebuilds the lines, and the ground
  // has to survive that rebuild rather than being drawn once at mount.
  it("survives the itinerary changing", async () => {
    const t = await open([]);
    await t.wrapper.setProps({ dayDistancesM: [800] });
    await nextTick();
    const paths = t.classes();
    expect(paths.filter((c) => c.includes("routemap__ground"))).toHaveLength(1);
    expect(paths.some((c) => c.includes("routemap__leg"))).toBe(true);
  });
});
