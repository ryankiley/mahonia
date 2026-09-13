// @vitest-environment nuxt
//
// The route-plan model used to be private implementation inside TrailPlanPanel. These
// assertions pin the contract at its new seam: route allocation remains half-open, the
// final endpoint stays with the last owned day, and a boundary drag updates only the
// affected adjacent days.
import { computed, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useTrailPlanRoute } from "~/composables/useTrailPlanRoute";
import { applyOps, type DayPatch } from "~~/shared/ops";
import type { ListSnapshot, TripDay } from "~~/shared/types";

function snapshot(): ListSnapshot {
  return {
    shareCode: "TRAILPLAN01",
    slug: "trail-plan-test",
    title: "Trail plan",
    description: "",
    displayUnit: "g",
    folders: [],
    items: [],
    version: 1,
    isPublic: false,
    trailDistanceM: 3_000,
    routeGeometry: "encoded-route",
    waypoints: [
      { id: "start", kind: "trailhead", alongM: 0 },
      { id: "boundary", kind: "water", alongM: 1_000 },
      { id: "finish", kind: "end", alongM: 3_000 },
    ],
  };
}

function open(days: TripDay[]) {
  const live = ref({ ...snapshot(), days });
  const stored = computed(() => live.value.days);
  const controller = { ensureRouteEnds: vi.fn(), updateDay: vi.fn<(id: string, patch: DayPatch) => void>() };
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

  it("seeds route ends when geometry is present", () => {
    const { controller } = open([]);
    expect(controller.ensureRouteEnds).toHaveBeenCalledTimes(1);
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
