import { dayColorSequence } from "~~/shared/categories";
import { cumulativeM, decodePolyline, sliceAlong, type LatLon } from "~~/shared/polyline";
import { dayRanges, nextOwnedDay } from "~~/shared/tripPlan";
import type { Ref } from "vue";

interface RouteMapGeometryInput {
  geometry: Readonly<Ref<string>>;
  dayDistancesM: Readonly<Ref<number[]>>;
}

/**
 * Pure route geometry for the interactive map.
 *
 * Leaflet should only consume already-derived lines and draggable boundaries. This
 * composable owns the route's length, colour allocation, and day-boundary constraints;
 * it does not know about map instances, markers, DOM, or pointer gestures.
 */
export function useRouteMapGeometry({ geometry, dayDistancesM }: RouteMapGeometryInput) {
  const points = computed<LatLon[]>(() => decodePolyline(geometry.value));
  const cum = computed(() => cumulativeM(points.value));
  const colors = computed(() => dayColorSequence(dayDistancesM.value.length));
  const ranges = computed(() => dayRanges(dayDistancesM.value));
  const routeLengthM = computed(() => cum.value.at(-1) ?? 0);

  const dayLegs = computed(() => {
    const legs: { points: LatLon[]; color: string; day: number; fromM: number; toM: number }[] = [];
    ranges.value.forEach(({ fromM, toM }, index) => {
      const pointsForDay = sliceAlong(points.value, fromM, toM, cum.value);
      if (pointsForDay.length >= 2) {
        legs.push({
          points: pointsForDay,
          color: colors.value[index] ?? "var(--cat-other)",
          day: index + 1,
          fromM,
          toM,
        });
      }
    });
    return legs;
  });

  // A boundary cannot erase a day. It trades ground with the next owned day, or
  // with the unclaimed tail after the final planned day.
  const boundaries = computed(() => {
    const distances = dayDistancesM.value;
    const total = routeLengthM.value;
    const out: { index: number; alongM: number; minM: number; maxM: number }[] = [];
    ranges.value.forEach(({ fromM, toM }, index) => {
      if (!(distances[index]! > 0)) return;
      const nextIndex = nextOwnedDay(distances, index);
      const minM = fromM + 200;
      if (nextIndex < 0) {
        if (toM < total - 200 && minM < total)
          out.push({ index, alongM: toM, minM, maxM: total });
        return;
      }
      const maxM = toM + distances[nextIndex]! - 200;
      if (minM < maxM) out.push({ index, alongM: toM, minM, maxM });
    });
    return out;
  });

  return { boundaries, colors, cum, dayLegs, points, ranges, routeLengthM };
}
