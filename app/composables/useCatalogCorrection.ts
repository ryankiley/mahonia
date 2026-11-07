import type { Unit } from "~~/shared/types";

// Drives the "fix a catalog weight for everyone" dialog. Singleton (module-level)
// like useGearList: the trigger lives in an ItemRow deep in the tree, the dialog
// is mounted once in the editor, and this connects them without prop-drilling.

interface CorrectionTarget {
  catalogItemId: number;
  itemName: string;
  catalogWeightMg: number; // the catalog's weight (what we're proposing to change)
  suggestedMg: number; // the user's current weight — prefilled as the suggestion
  displayUnit: Unit;
}

interface CorrectionResult {
  status: "applied" | "proposed" | "noop" | "rejected" | "notfound";
  weightMg?: number;
  itemName?: string;
}

// Closed, open on a target, or sending for it. One value, so nothing can be sending for
// a dialog that isn't up, and a request knows whether the dialog is still the one it was
// sent from.
const correction = shallowRef<{ target: CorrectionTarget; sending: boolean } | null>(null);
const target = computed(() => correction.value?.target ?? null);
const submitting = computed(() => correction.value?.sending ?? false);

export function useCatalogCorrection() {
  function open(t: CorrectionTarget) {
    correction.value = { target: t, sending: false };
  }
  function close() {
    correction.value = null;
  }
  async function submit(payload: {
    weight?: string;
    weightMg?: number; // exact mg — preferred over the parsed string when present
    sourceUrl?: string;
    reason?: string;
  }): Promise<CorrectionResult | null> {
    // the button is gated, but Enter in any of the fields comes straight here
    const held = correction.value;
    if (!held || held.sending) return null;
    const sent = { target: held.target, sending: true };
    correction.value = sent;
    try {
      return await $fetch<CorrectionResult>("/api/catalog/correct", {
        method: "POST",
        body: {
          catalogItemId: held.target.catalogItemId,
          weight: payload.weight,
          weightMg: payload.weightMg,
          sourceUrl: payload.sourceUrl,
          reason: payload.reason,
        },
      });
    } catch {
      return { status: "rejected" };
    } finally {
      if (correction.value === sent) correction.value = { target: held.target, sending: false };
    }
  }
  return { target, submitting, open, close, submit };
}
