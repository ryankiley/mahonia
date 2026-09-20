import type { ListSnapshot, Totals, TripDay } from "~~/shared/types";
import { burnDownMg } from "~~/shared/tripPlan";
import { isWaterName } from "~~/shared/water";
import { effectiveClassification, lineMg } from "~~/shared/weights";
import {
  bodyWeightFieldValue,
  heightUnitFor,
  heightValue,
  parseBodyWeightG,
  resolveDistanceUnit,
} from "~~/shared/trailDistance";
import type { ComputedRef, Ref } from "vue";

interface TripLoadModelInput {
  snapshot: Readonly<Ref<ListSnapshot>>;
  totals: Readonly<Ref<Totals>>;
  days: Readonly<ComputedRef<(TripDay | null)[]>>;
}

/**
 * The trip-wide weight and walker inputs behind the planning view.
 *
 * This is deliberately separate from itinerary allocation: it answers how much the
 * walker carries and which units the panel speaks, without knowing about a route,
 * waypoint, map, or piece of panel markup.
 */
export function useTripLoadModel({ snapshot, totals, days }: TripLoadModelInput) {
  const distanceUnit = computed(() => resolveDistanceUnit(snapshot.value.trailDistanceUnit));
  const ascentUnit = computed(() => heightUnitFor(distanceUnit.value));
  const totalDistanceM = computed(() => days.value.reduce((sum, day) => sum + (day?.distanceM ?? 0), 0));
  const headlineM = computed(() => Math.max(snapshot.value.trailDistanceM ?? 0, totalDistanceM.value));
  const routeDescentDiffers = computed(
    () =>
      snapshot.value.trailDescentM != null &&
      snapshot.value.trailAscentM != null &&
      snapshot.value.trailDescentM !== snapshot.value.trailAscentM,
  );
  const totalAscentM = computed(() => days.value.reduce((sum, day) => sum + (day?.ascentM ?? 0), 0));

  // Water refills. It belongs in carried weight but never in consumables burned down.
  const burnableMg = computed(() => {
    const waterMg = snapshot.value.items
      .filter((item) => isWaterName(item.name))
      .filter((item) => effectiveClassification(item, snapshot.value.folders) === "consumable")
      .reduce((sum, item) => sum + lineMg(item), 0);
    return Math.max(0, totals.value.consumableMg - waterMg);
  });
  const packMg = computed(() => burnDownMg(totals.value.carriedMg, burnableMg.value, days.value.length));

  // The walker is device-local rather than part of a shared/exportable list snapshot.
  const body = useBodyWeight(snapshot.value.displayUnit);
  const bodyUnit = body.unit;
  const bodyG = body.value;
  const bodyIsDefault = body.isDefault;
  const bodyFieldValue = computed(() =>
    body.stored.value ? bodyWeightFieldValue(body.stored.value, bodyUnit.value) : "",
  );
  function commitBody(event: Event) {
    const raw = (event.target as HTMLInputElement).value.trim();
    body.set(raw ? parseBodyWeightG(raw, bodyUnit.value) : null);
  }

  const routeHeight = (metres: number | undefined) =>
    metres == null ? "" : heightValue(metres, distanceUnit.value);

  return {
    ascentUnit,
    bodyFieldValue,
    bodyG,
    bodyIsDefault,
    bodyUnit,
    commitBody,
    distanceUnit,
    headlineM,
    packMg,
    routeDescentDiffers,
    routeHeight,
    setBodyUnit: body.setUnit,
    totalAscentM,
  };
}
