// What a pin's popup offers. A pin somebody placed can be named and removed from it. The
// route's own trailhead and finish can be named there and not removed: they came with the
// route, and only a new route would put one back. A list holding two of either (a copy
// made while duplicates doubled them) can remove the spare, down to the one the route has.
//
// Mounted because the popup is DOM that Leaflet builds on a click of the marker, so the
// thing to press is a real marker on a real map.
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount } from "@vue/test-utils";
import { mountRouteMap } from "./helpers/routeMap";

enableAutoUnmount(afterEach);

/** Mount a map holding one pin of each kind given (ids "pin0", "pin1", … all on one
 *  spot, as doubled ends are), press the first, and hand back its popup. */
async function openFirstPopup(...kinds: string[]) {
  const { wrapper, root } = await mountRouteMap(
    { waypoints: kinds.map((kind, i) => ({ id: `pin${i}`, kind, alongM: 400 })) },
    { ready: (map) => map.querySelectorAll(".leaflet-marker-icon").length === kinds.length },
  );
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
