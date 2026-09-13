import type { DayPatch } from "~~/shared/ops";
import { dayColorSequence } from "~~/shared/categories";
import { dayEnds as endsForDays, dayRanges, lastOwnedDayIndex, nextOwnedDay } from "~~/shared/tripPlan";
import type { ListSnapshot, TripDay, Waypoint } from "~~/shared/types";
import type { ComputedRef, Ref } from "vue";

/**
 * The route-facing state of a trip plan.
 *
 * The panel has a sizeable visual surface, but this cluster is not presentation: it
 * decides which stretch a day owns, where a waypoint belongs, and which two stored
 * days a dragged boundary updates. Keeping it here makes that state independently
 * readable and keeps the panel responsible for laying the answer out.
 */
interface TrailPlanRouteController {
  ensureRouteEnds: () => void;
  updateDay: (id: string, patch: DayPatch) => void;
}

interface TrailPlanRouteInput {
  snapshot: Readonly<Ref<ListSnapshot>>;
  stored: Readonly<ComputedRef<TripDay[]>>;
  days: Readonly<ComputedRef<(TripDay | null)[]>>;
  controller: TrailPlanRouteController;
}

export function useTrailPlanRoute({ snapshot, stored, days, controller }: TrailPlanRouteInput) {
  // A blank day owns no ground. The neutral tail is deliberately left unassigned
  // until someone gives it a distance, rather than inventing an even allocation.
  const dayDistancesM = computed(() => days.value.map((day) => day?.distanceM ?? 0));
  const dayColors = computed(() => dayColorSequence(days.value.length));
  const ranges = computed(() => dayRanges(dayDistancesM.value));

  const restFromM = computed(() => ranges.value.at(-1)?.toM ?? 0);
  const restRange = computed(() => ({
    fromM: restFromM.value,
    toM: snapshot.value.trailDistanceM ?? 0,
  }));
  const hasRest = computed(() => restRange.value.toM > restRange.value.fromM + 1);

  // A waypoint's chainage is its order. There is no independent sort order to
  // maintain or allow to drift from the line it describes.
  const waypoints = computed(() =>
    [...(snapshot.value.waypoints ?? [])].sort((a, b) => a.alongM - b.alongM),
  );

  /** Waypoints grouped by the day stretch that contains them (or unclaimed ground). */
  const grouped = computed(() => {
    const byDay: Waypoint[][] = ranges.value.map(() => []);
    const rest: Waypoint[] = [];
    const dayFor = (alongM: number) => {
      // Half-open ranges put a boundary pin at the beginning of its following day.
      const i = ranges.value.findIndex(
        (range) => range.toM > range.fromM && alongM >= range.fromM && alongM < range.toM,
      );
      if (i >= 0) return i;
      // The final endpoint has no following day, so it belongs to the final owned one.
      if (restFromM.value > 0 && alongM === restFromM.value)
        return ranges.value.findLastIndex((range) => range.toM > range.fromM);
      return -1;
    };
    for (const waypoint of waypoints.value) {
      const i = dayFor(waypoint.alongM);
      if (i >= 0) byDay[i]!.push(waypoint);
      else rest.push(waypoint);
    }
    return { byDay, rest };
  });

  // Placement is deliberately opt-in: a map remains a pan surface until a day (or
  // its unclaimed tail) explicitly arms a constrained stretch.
  const arming = ref<number | "rest" | null>(null);
  const traceM = ref<number | null>(null);

  // Routes written before end pins existed gain them once, when their geometry arrives.
  watch(
    () => snapshot.value.routeGeometry,
    (geometry) => {
      if (geometry) controller.ensureRouteEnds();
    },
    { immediate: true },
  );

  const armedRange = computed(() => {
    if (arming.value === null) return null;
    if (arming.value === "rest") return restRange.value;
    const range = ranges.value[arming.value];
    if (!range) return null;
    // Day ranges are half-open; keep an out-of-range tap from crossing a day boundary.
    return { fromM: range.fromM, toM: Math.max(range.fromM, range.toM - 1) };
  });

  /**
   * A boundary trades ground between adjacent owned days. The final boundary instead
   * trades against the unclaimed tail. One update per affected day is the persistent
   * outcome of an entire drag, never a stream of pointer-move writes.
   */
  function onBoundary({ index, alongM }: { index: number; alongM: number }) {
    const from = ranges.value[index]?.fromM;
    const id = stored.value[index]?.id;
    if (from == null || !id) return;

    // Capture both original boundaries before an update recomputes the live ranges.
    const nextIndex = nextOwnedDay(dayDistancesM.value, index);
    const next = nextIndex >= 0 ? ranges.value[nextIndex] : undefined;
    const nextId = nextIndex >= 0 ? stored.value[nextIndex]?.id : undefined;
    controller.updateDay(id, { distanceM: Math.max(1, Math.round(alongM - from)) });
    if (next && nextId)
      controller.updateDay(nextId, { distanceM: Math.max(1, Math.round(next.toM - alongM)) });
  }

  const endPinsAtM = computed(() =>
    waypoints.value.filter((waypoint) => waypoint.kind === "end").map((waypoint) => waypoint.alongM),
  );
  const dayEnds = computed(() =>
    endsForDays({
      ranges: ranges.value,
      dayDistancesM: dayDistancesM.value,
      hasRest: hasRest.value,
      endPinsAtM: endPinsAtM.value,
    }),
  );
  // The sentence beneath a day still needs to call its last stop a finish when an
  // end pin renders that finish in its own row. Deliberately omit those pins here:
  // this answers the day's semantic end, not whether the panel should repeat it.
  const finishDayIndex = computed(() => hasRest.value ? -1 : lastOwnedDayIndex(dayDistancesM.value));
  const routeFinishM = computed(() =>
    dayEnds.value.find((end) => end?.kind === "finish")?.alongM ?? null,
  );

  return {
    armedRange,
    arming,
    dayColors,
    dayDistancesM,
    dayEnds,
    finishDayIndex,
    grouped,
    hasRest,
    onBoundary,
    ranges,
    restFromM,
    restRange,
    routeFinishM,
    traceM,
    waypoints,
  };
}
