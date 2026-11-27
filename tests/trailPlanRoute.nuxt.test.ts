// The route-plan model used to be private implementation inside TrailPlanPanel. These
// assertions pin the contract at its new seam: route allocation remains half-open, the
// final endpoint stays with the last owned day, and a boundary drag updates only the
// affected adjacent days.
import { computed, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { createEdits } from "~/composables/useGearListEdits";
import { useTrailPlanRoute } from "~/composables/useTrailPlanRoute";
import { cloneListData } from "~~/shared/clone";
import { applyOps, type DayPatch } from "~~/shared/ops";
import { encodePolyline } from "~~/shared/polyline";
import { pickListMeta, type ListSnapshot, type TripDay } from "~~/shared/types";
import { snapshotFor } from "./helpers/list";

function snapshot(): ListSnapshot {
  return snapshotFor({
    shareCode: "TRAILPLAN01",
    slug: "trail-plan-test",
    title: "Trail plan",
    trailDistanceM: 3_000,
    routeGeometry: "encoded-route",
    waypoints: [
      { id: "start", kind: "trailhead", alongM: 0 },
      { id: "boundary", kind: "water", alongM: 1_000 },
      { id: "finish", kind: "end", alongM: 3_000 },
    ],
  });
}

function open(days: TripDay[]) {
  const live = ref({ ...snapshot(), days });
  const stored = computed(() => live.value.days);
  const controller = { updateDay: vi.fn<(id: string, patch: DayPatch) => void>() };
  const plan = useTrailPlanRoute({
    snapshot: live,
    stored,
    days: stored,
    controller,
  });
  return { controller, live, plan };
}

describe("useTrailPlanRoute", () => {
  it("groups boundary pins with the following day and the final endpoint with the last owned day", () => {
    const days: TripDay[] = [
      { id: "d1", sortOrder: 0, distanceM: 1_000 },
      { id: "d2", sortOrder: 1, distanceM: 2_000 },
    ];
    const { plan } = open(days);

    expect(plan.grouped.value.byDay.map((group) => group.map((waypoint) => waypoint.id))).toEqual([
      ["start"],
      ["boundary", "finish"],
    ]);
    expect(plan.grouped.value.rest).toEqual([]);
  });

  it("keeps an armed day range inside its half-open boundary", async () => {
    const days: TripDay[] = [{ id: "d1", sortOrder: 0, distanceM: 1_000 }];
    const { plan } = open(days);

    plan.arming.value = 0;
    await nextTick();
    expect(plan.armedRange.value).toEqual({ fromM: 0, toM: 999 });

    plan.arming.value = "rest";
    await nextTick();
    expect(plan.armedRange.value).toEqual({ fromM: 1_000, toM: 3_000 });
  });

  // Armed means "the next tap places a pin in THIS stretch". When the stretch goes,
  // so does the arming: left on, every leg stayed dimmed and every tap clamped to one
  // point, with every control that could turn it off hidden along with the stretch.
  describe("arming outlives nothing it points at", () => {
    const three = (): TripDay[] => [
      { id: "d1", sortOrder: 0, distanceM: 1_000 },
      { id: "d2", sortOrder: 1, distanceM: 1_000 },
      { id: "d3", sortOrder: 2, distanceM: 500 },
    ];

    it("disarms when the armed day's distance is cleared", async () => {
      const { live, plan } = open(three());
      plan.arming.value = 1;
      await nextTick();
      live.value = { ...live.value, days: live.value.days!.map((d) => (d.id === "d2" ? { ...d, distanceM: 0 } : d)) };
      await nextTick();
      expect(plan.arming.value).toBeNull();
      expect(plan.armedRange.value).toBeNull();
    });

    it("disarms rather than re-aim at the next day when the armed one is deleted", async () => {
      const { live, plan } = open(three());
      plan.arming.value = 1;
      await nextTick();
      live.value = { ...live.value, days: live.value.days!.filter((d) => d.id !== "d2") };
      await nextTick();
      expect(plan.arming.value).toBeNull();
    });

    it("disarms the rest of the route once there's no rest left", async () => {
      const { live, plan } = open(three());
      plan.arming.value = "rest";
      await nextTick();
      live.value = { ...live.value, days: live.value.days!.map((d) => (d.id === "d3" ? { ...d, distanceM: 1_000 } : d)) };
      await nextTick();
      expect(plan.arming.value).toBeNull();
    });

    it("stays armed through an edit that leaves its stretch in place", async () => {
      const { live, plan } = open(three());
      plan.arming.value = 1;
      await nextTick();
      live.value = { ...live.value, days: live.value.days!.map((d) => (d.id === "d3" ? { ...d, distanceM: 400 } : d)) };
      await nextTick();
      expect(plan.arming.value).toBe(1);
    });
  });

  it("trades a moved boundary with the next owned day in exactly two updates", () => {
    const days: TripDay[] = [
      { id: "d1", sortOrder: 0, distanceM: 1_000 },
      { id: "d2", sortOrder: 1, distanceM: 2_000 },
    ];
    const { controller, plan } = open(days);

    plan.onBoundary({ index: 0, alongM: 1_250 });

    expect(controller.updateDay).toHaveBeenCalledTimes(2);
    expect(controller.updateDay).toHaveBeenNthCalledWith(1, "d1", { distanceM: 1_250 });
    expect(controller.updateDay).toHaveBeenNthCalledWith(2, "d2", { distanceM: 1_750 });
  });

  // A copy's pins arrive with fresh ids, its route's two ends among them, and the plan
  // opens on the list as it is stored. Driven through the editor's own edits and the
  // reducer, so anything the plan dispatches on opening lands in the list it shows.
  it("opens a duplicated route with the one trailhead and the one finish it was copied with", () => {
    const source = applyOps(snapshotFor(), [
      {
        t: "setMeta",
        patch: {
          routeGeometry: encodePolyline([
            { lat: 45.33, lon: -121.71 },
            { lat: 45.36, lon: -121.68 },
            { lat: 45.4, lon: -121.6 },
          ]),
        },
      },
      { t: "addWaypoint", waypoint: { id: "spring", kind: "water", alongM: 1_500 } },
    ]);
    const live = ref<ListSnapshot>({ ...snapshotFor(), ...pickListMeta(source), ...cloneListData(source) });
    const stored = computed(() => live.value.days ?? []);
    const controller = createEdits({
      snapshot: live,
      dispatch: (op) => void applyOps(live.value, [op]),
      offerUndo: () => {},
      pendingBlankId: ref(null),
    });

    const plan = useTrailPlanRoute({ snapshot: live, stored, days: stored, controller });

    expect(plan.waypoints.value.map((waypoint) => waypoint.kind)).toEqual(["trailhead", "water", "end"]);
  });

  it("preserves the itinerary length when each boundary update applies synchronously", () => {
    const { controller, live, plan } = open([
      { id: "d1", sortOrder: 0, distanceM: 1_000 },
      { id: "blank", sortOrder: 1, distanceM: 0 },
      { id: "d2", sortOrder: 2, distanceM: 2_000 },
    ]);
    controller.updateDay.mockImplementation((id, patch) => {
      applyOps(live.value, [{ t: "updateDay", id, patch }]);
    });

    plan.onBoundary({ index: 0, alongM: 1_250 });

    expect(plan.dayDistancesM.value).toEqual([1_250, 0, 1_750]);
    expect(plan.restFromM.value).toBe(3_000);
  });

  it("keeps a pinned finish on the last owned day and clears it when ground is left unplanned", () => {
    const { live, plan } = open([
      { id: "d1", sortOrder: 0, distanceM: 1_000 },
      { id: "d2", sortOrder: 1, distanceM: 2_000 },
      { id: "blank", sortOrder: 2, distanceM: 0 },
    ]);

    expect(plan.finishDayIndex.value).toBe(1);
    expect(plan.dayEnds.value).toEqual([{ kind: "camp", alongM: 1_000 }, null, null]);
    live.value.days[1]!.distanceM = 1_500;
    expect(plan.finishDayIndex.value).toBe(-1);
    expect(plan.dayEnds.value[1]).toEqual({ kind: "camp", alongM: 2_500 });
  });
});
