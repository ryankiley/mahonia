import type { PersonSelection } from "~~/shared/people";
import type { ListSnapshot, TripDay } from "~~/shared/types";
import { walkerLoad } from "~~/shared/tripLoad";
import { burnDownMg, descentIsDistinct } from "~~/shared/tripPlan";
import {
  bodyWeightFieldValue,
  heightUnitFor,
  heightValue,
  parseBodyWeightG,
  resolveDistanceUnit,
  routeLengthM,
} from "~~/shared/trailDistance";
import type { ComputedRef, Ref } from "vue";

interface TripLoadModelInput {
  snapshot: Readonly<Ref<ListSnapshot>>;
  /** the person chip picked; the walker carries that person's pack (shared/tripLoad.ts) */
  selection: Readonly<Ref<PersonSelection>>;
  days: Readonly<ComputedRef<(TripDay | null)[]>>;
}

/**
 * The trip-wide weight and walker inputs behind the planning view.
 *
 * This is deliberately separate from itinerary allocation: it answers how much the
 * walker carries and which units the panel speaks, without knowing about a route,
 * waypoint, map, or piece of panel markup.
 */
export function useTripLoadModel({ snapshot, selection, days }: TripLoadModelInput) {
  const distanceUnit = computed(() => resolveDistanceUnit(snapshot.value.trailDistanceUnit));
  const ascentUnit = computed(() => heightUnitFor(distanceUnit.value));
  const totalDistanceM = computed(() => days.value.reduce((sum, day) => sum + (day?.distanceM ?? 0), 0));
  const headlineM = computed(() => routeLengthM(snapshot.value.trailDistanceM, [totalDistanceM.value]));
  const routeDescentDiffers = computed(() =>
    descentIsDistinct(snapshot.value.trailAscentM, snapshot.value.trailDescentM),
  );
  const totalAscentM = computed(() => days.value.reduce((sum, day) => sum + (day?.ascentM ?? 0), 0));

  // One walker's pack, not every pack on a group list; water stays carried but uneaten.
  const load = computed(() => walkerLoad(snapshot.value, selection.value));
  const packMg = computed(() => burnDownMg(load.value.carriedMg, load.value.burnableMg, days.value.length));

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
    load,
    packMg,
    routeDescentDiffers,
    routeHeight,
    setBodyUnit: body.setUnit,
    totalAscentM,
  };
}
