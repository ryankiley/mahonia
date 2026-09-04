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

const target = ref<CorrectionTarget | null>(null);
const submitting = ref(false);

export function useCatalogCorrection() {
  function open(t: CorrectionTarget) {
    target.value = t;
  }
  function close() {
    target.value = null;
    submitting.value = false;
  }
  async function submit(payload: {
    weight?: string;
    weightMg?: number; // exact mg — preferred over the parsed string when present
    sourceUrl?: string;
    reason?: string;
  }): Promise<CorrectionResult | null> {
    if (!target.value) return null;
    submitting.value = true;
    try {
      return await $fetch<CorrectionResult>("/api/catalog/correct", {
        method: "POST",
        body: {
          catalogItemId: target.value.catalogItemId,
          weight: payload.weight,
          weightMg: payload.weightMg,
          sourceUrl: payload.sourceUrl,
          reason: payload.reason,
        },
      });
    } catch {
      return { status: "rejected" };
    } finally {
      submitting.value = false;
    }
  }
  return { target, submitting, open, close, submit };
}
