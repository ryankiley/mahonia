// What a pin's popup offers. A pin somebody placed can be named and removed from it. The
// route's own trailhead and finish can be named there and not removed: they came with the
// route, and only a new route would put one back. A list holding two of either (a copy
// made while duplicates doubled them) can remove the spare, down to the one the route has.
//
// Mounted because the popup is DOM that Leaflet builds on a click of the marker, so the
// thing to press is a real marker on a real map.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount, type VueWrapper } from "@vue/test-utils";
import RouteMap from "~/components/RouteMap.client.vue";
import { encodePolyline } from "~~/shared/polyline";

const geometry = encodePolyline([
  { lat: 45.3736, lon: -121.696 },
  { lat: 45.378, lon: -121.69 },
  { lat: 45.382, lon: -121.684 },
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

enableAutoUnmount(afterEach);

/** Mount a map holding one pin of each kind given (ids "pin0", "pin1", … all on one
 *  spot, as doubled ends are), press the first, and hand back its popup. */
async function openFirstPopup(...kinds: string[]) {
  const wrapper: VueWrapper = mount(RouteMap, {
    props: { geometry, dayDistancesM: [], waypoints: kinds.map((kind, i) => ({ id: `pin${i}`, kind, alongM: 400 })) },
    attachTo: document.body,
  });
  const root = wrapper.element as HTMLElement;
  await vi.waitFor(() => expect(root.querySelectorAll(".leaflet-marker-icon")).toHaveLength(kinds.length), { interval: 25 });
  root.querySelector(".leaflet-marker-icon")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => expect(root.querySelector(".routemap__wp")).not.toBeNull(), { interval: 25 });
  const popup = root.querySelector<HTMLElement>(".routemap__wp")!;
  return { wrapper, popup, remove: () => popup.querySelector<HTMLButtonElement>("button") };
}

describe("a pin's popup on the route map", () => {
  it("removes a pin somebody placed", async () => {
    const { wrapper, popup, remove } = await openFirstPopup("water");
    expect(popup.querySelector("input")).not.toBeNull();
    expect(remove()?.textContent).toBe("Remove");
    remove()!.click();
    expect(wrapper.emitted("remove")).toEqual([["pin0"]]);
  });

  it.each(["trailhead", "end"])("offers a name and no Remove for the route's only %s", async (kind) => {
    // the other end and a placed pin beside it: only its own kind is counted
    const { wrapper, popup, remove } = await openFirstPopup(kind, kind === "end" ? "trailhead" : "end", "water");
    expect(popup.querySelector("input")).not.toBeNull();
    expect(remove()).toBeNull();
    expect(wrapper.emitted("remove")).toBeUndefined();
  });

  it.each(["trailhead", "end"])("removes a spare %s from a list holding two", async (kind) => {
    const { wrapper, remove } = await openFirstPopup(kind, kind);
    expect(remove()?.textContent).toBe("Remove");
    remove()!.click();
    expect(wrapper.emitted("remove")).toEqual([["pin0"]]);
  });
});
