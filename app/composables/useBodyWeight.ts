import {
  DEFAULT_BODY_G,
  bodyWeightUnitFor,
  normalizeBodyWeightG,
  normalizeBodyWeightUnit,
  type BodyWeightUnit,
} from "~~/shared/trailDistance";
import { remember } from "../utils/remember";

// Your body weight, for the trip estimates.
//
// It lives on the DEVICE, not on a list and not on an account. That is the whole design,
// and it follows from what the value is: a body weight is a property of the walker, so
// storing it per-list meant re-entering it on every trip and asking every read path to
// remember to strip it. It was stripped by an opt-in wrapper that three separate code
// paths forgot, which is exactly the failure mode a per-list secret invites.
//
// Here there is nothing to strip. The value never reaches the server, never rides an
// autosave, never enters a snapshot, never appears in a JSON backup, and cannot leak
// through a share link, because it is never sent anywhere. "It stays on your device" is a
// fact about what the code can do rather than a promise about what it chooses to do.
//
// The pattern is My Gear's metric/imperial preference (app/pages/gear.vue): a
// device-level setting that takes its default from context and remembers an explicit
// choice from there. Not an account setting — lists need no account, and gating the one
// number the burn model wants behind a sign-in would make the estimates a feature only
// signed-in people get.
const GRAMS_KEY = "gear.bodyweight.v1";
const UNIT_KEY = "gear.bodyweight.unit.v1";

// Module-level, so every list and every component share one value without prop-drilling
// or a round trip. Same shape as useMyLists.
const grams = ref<number | null>(null);
const unit = ref<BodyWeightUnit>("kg");
let loaded = false;

/**
 * `displayUnit` seeds the UNIT only, and only when nothing has been chosen — a list in
 * ounces implies a person who thinks in pounds. It never seeds the weight itself: there
 * is no honest guess at that, which is why the default is stated rather than pre-filled.
 */
export function useBodyWeight(displayUnit?: string) {
  if (import.meta.client && !loaded) {
    loaded = true;
    try {
      grams.value = normalizeBodyWeightG(localStorage.getItem(GRAMS_KEY)) ?? null;
      unit.value = normalizeBodyWeightUnit(localStorage.getItem(UNIT_KEY)) ?? bodyWeightUnitFor(displayUnit);
    } catch {
      /* storage blocked — the default holds for this visit */
    }
    // another tab is the same device and the same person
    window.addEventListener("storage", (e) => {
      if (e.key === GRAMS_KEY) grams.value = normalizeBodyWeightG(e.newValue) ?? null;
      if (e.key === UNIT_KEY) unit.value = normalizeBodyWeightUnit(e.newValue) ?? unit.value;
    });
  }

  return {
    /** What the estimates actually use — the set value, or the stated assumption. */
    value: computed(() => grams.value ?? DEFAULT_BODY_G),
    /** Null until someone sets one. The UI says "assumed" while this is true, because a
     *  pre-filled field looks like something you already confirmed. */
    stored: readonly(grams),
    isDefault: computed(() => grams.value == null),
    unit: readonly(unit),
    /** Null or an out-of-range value clears it and returns to the stated assumption. */
    set(next: number | null) {
      grams.value = next == null ? null : (normalizeBodyWeightG(next) ?? null);
      if (grams.value == null) {
        try {
          localStorage.removeItem(GRAMS_KEY);
        } catch {
          /* as above */
        }
      } else {
        remember(GRAMS_KEY, String(grams.value));
      }
    },
    setUnit(next: BodyWeightUnit) {
      unit.value = next;
      remember(UNIT_KEY, next);
    },
  };
}
