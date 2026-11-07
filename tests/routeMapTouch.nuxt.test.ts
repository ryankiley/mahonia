// The inline route map gives one finger back to the page on a phone.
//
// Leaflet's drag handler puts `touch-action: none` on the whole map, so on a phone a swipe
// down the page that crossed the 320px strip panned the terrain instead, and the page
// stopped scrolling under your thumb. On a coarse pointer the map is now built without
// dragging while it sits in the page (two fingers still pinch, and pan as they pinch), and
// gets it back while it's expanded, where the map IS the page. A mouse keeps it always.
//
// Leaflet marks the state on its container — `leaflet-touch-drag` is the class that
// carries `touch-action: none` in its stylesheet — so that class is what's read here: it
// is the thing that decides who a finger belongs to.
//
// Also pinned: the close's wait. It re-parks the map after the clip's slide, which under
// reduced motion or from the keyboard (Escape) is no slide at all — and the map used to sit
// over the page for the full beat anyway.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount, type VueWrapper } from "@vue/test-utils";
import RouteMap from "~/components/RouteMap.client.vue";
import { encodePolyline } from "~~/shared/polyline";

const geometry = encodePolyline([
  { lat: 45.3736, lon: -121.696 },
  { lat: 45.378, lon: -121.69 },
  { lat: 45.382, lon: -121.684 },
]);

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

enableAutoUnmount(afterEach);

/** Which media queries match, per case. */
let matching = new Set<string>();
beforeEach(() => {
  matching = new Set();
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: matching.has(q),
        media: q,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.input;
});

async function open() {
  const wrapper: VueWrapper = mount(RouteMap, { props: { geometry, dayDistancesM: [] }, attachTo: document.body });
  await vi.waitFor(() => expect(wrapper.element.querySelector(".leaflet-container")).not.toBeNull(), { interval: 25 });
  const container = () => wrapper.element.querySelector(".leaflet-container")!;
  return {
    wrapper,
    oneFingerPans: () => container().classList.contains("leaflet-touch-drag"),
    // the figure carries the state classes (see the template); the mount's root element
    // is a wrapper around it, so it's found rather than assumed
    expanded: () => wrapper.element.querySelector(".routemap")!.classList.contains("is-expanded"),
    expand: () => wrapper.find(".routemap__expand").trigger("click"),
  };
}
const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

describe("one finger on the route map", () => {
  it("belongs to the page while a phone's map is inline", async () => {
    matching.add("(pointer: coarse)");
    const m = await open();
    expect(m.oneFingerPans()).toBe(false);
  });

  it("pans the map once it's expanded, and goes back to the page when it shrinks", async () => {
    matching.add("(pointer: coarse)");
    const m = await open();
    await m.expand();
    expect(m.expanded()).toBe(true);
    expect(m.oneFingerPans()).toBe(true);
    document.documentElement.dataset.input = "keyboard";
    escape();
    await vi.waitFor(() => expect(m.expanded()).toBe(false));
    expect(m.oneFingerPans()).toBe(false);
  });

  it("drags the map everywhere with a mouse, as it always has", async () => {
    const m = await open();
    expect(m.oneFingerPans()).toBe(true);
  });
});

describe("closing the expanded map", () => {
  // the 630ms beat is for watching the clip slide home; with no slide there is nothing
  // to wait for
  it("is immediate from the keyboard", async () => {
    const m = await open();
    await m.expand();
    document.documentElement.dataset.input = "keyboard";
    escape();
    await Promise.resolve();
    expect(m.expanded()).toBe(false);
  });

  it("is immediate under reduced motion", async () => {
    matching.add("(prefers-reduced-motion: reduce)");
    const m = await open();
    await m.expand();
    await m.expand(); // the same button shrinks it
    await Promise.resolve();
    expect(m.expanded()).toBe(false);
  });

  it("waits out the slide for a pointer, with motion on", async () => {
    const m = await open();
    await m.expand();
    await m.expand();
    await Promise.resolve();
    expect(m.expanded()).toBe(true); // still sliding home
    await vi.waitFor(() => expect(m.expanded()).toBe(false), { timeout: 2_000 });
  });
});
