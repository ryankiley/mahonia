// What a pin's popup offers. A pin somebody placed can be named and removed from it. The
// route's own two ends can be named there and nothing else: they came with the route, the
// plan's rows offer no delete for them, and only a new route would put one back.
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

/** Mount a map holding one pin, press that pin, and hand back its popup. */
async function openPopupFor(kind: string) {
  const wrapper: VueWrapper = mount(RouteMap, {
    props: { geometry, dayDistancesM: [], waypoints: [{ id: "pin", kind, alongM: 400 }] },
    attachTo: document.body,
  });
  const find = (selector: string) => (wrapper.element as HTMLElement).querySelector<HTMLElement>(selector);
  await vi.waitFor(() => expect(find(".leaflet-marker-icon")).not.toBeNull(), { interval: 25 });
  find(".leaflet-marker-icon")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => expect(find(".routemap__wp")).not.toBeNull(), { interval: 25 });
  const popup = find(".routemap__wp")!;
  return { wrapper, popup, remove: () => popup.querySelector<HTMLButtonElement>("button") };
}

describe("a pin's popup on the route map", () => {
  it("removes a pin somebody placed", async () => {
    const { wrapper, popup, remove } = await openPopupFor("water");
    expect(popup.querySelector("input")).not.toBeNull();
    expect(remove()?.textContent).toBe("Remove");
    remove()!.click();
    expect(wrapper.emitted("remove")).toEqual([["pin"]]);
  });

  it.each(["trailhead", "end"])("offers a name and no Remove for the route's %s", async (kind) => {
    const { wrapper, popup, remove } = await openPopupFor(kind);
    expect(popup.querySelector("input")).not.toBeNull();
    expect(remove()).toBeNull();
    expect(wrapper.emitted("remove")).toBeUndefined();
  });
});
