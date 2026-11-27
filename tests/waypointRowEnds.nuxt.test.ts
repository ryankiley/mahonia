// A pin's row in the plan offers a delete for a pin somebody placed and none for the
// route's own trailhead or finish, which came with the route and would not come back. A
// list holding two of either can delete the spare, down to the one the route has.
//
// Mounted because the rule is in what the row renders, and it reads the list's other pins
// from the editor's controller.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import WaypointRow from "~/components/WaypointRow.vue";
import type { ListSnapshot, Waypoint, WaypointKind } from "~~/shared/types";
import { blankList } from "./helpers/list";

const snapshot = ref<ListSnapshot>(blankList());
const removeWaypoint = vi.fn();
mockNuxtImport("useGearList", () => () => ({ snapshot, removeWaypoint }));

enableAutoUnmount(afterEach);
afterEach(() => vi.clearAllMocks());

/** A list holding one pin of each kind given, and the row for the first of them. */
function rowForFirst(...kinds: WaypointKind[]) {
  const waypoints: Waypoint[] = kinds.map((kind, i) => ({ id: `pin${i}`, kind, alongM: 0 }));
  snapshot.value = blankList({ waypoints });
  const row = mount(WaypointRow, { props: { waypoint: waypoints[0]!, distanceUnit: "km" } });
  return { del: () => row.find("button.wprow__del") };
}

describe("a pin's row in the plan", () => {
  it("deletes a pin somebody placed", async () => {
    const { del } = rowForFirst("water");
    await del().trigger("click");
    expect(removeWaypoint).toHaveBeenCalledWith("pin0");
  });

  it.each(["trailhead", "end"] as const)("offers no delete for the route's only %s", (kind) => {
    const { del } = rowForFirst(kind, kind === "end" ? "trailhead" : "end", "water");
    expect(del().exists()).toBe(false);
  });

  it.each(["trailhead", "end"] as const)("deletes a spare %s from a list holding two", async (kind) => {
    const { del } = rowForFirst(kind, kind);
    await del().trigger("click");
    expect(removeWaypoint).toHaveBeenCalledWith("pin0");
  });
});
