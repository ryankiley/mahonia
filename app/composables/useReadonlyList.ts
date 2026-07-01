import type { Ref } from "vue";
import type { ListSnapshot, Totals, Unit } from "~~/shared/types";
import { computeTotals, formatWeightAuto } from "~~/shared/weights";
import { seasonLabel, tripTypeLabel } from "~~/shared/discovery";

// Shared reactive view-model for the two read-only pages (/s/[code] + /l/[slug]):
// a viewer-chosen display unit, the rolled-up totals, the unit-reskinned list the
// readonly components render, and the non-empty folders/ungrouped split. The two
// pages differ only in chrome (SEO/report on /l, live-poll on /s) — the data
// shaping is identical and lives here so it can't drift.
export function useReadonlyList(snapshot: Ref<ListSnapshot | null>) {
  // Shared read-only views always START in grams — they deliberately DON'T inherit
  // the owner's saved displayUnit, so a shared link reads the same for everyone
  // regardless of the unit the owner happens to edit in. The viewer can still
  // toggle the unit locally (below); that choice is never persisted.
  const unit = ref<Unit>("g");
  const totals = computed(() => (snapshot.value ? computeTotals(snapshot.value) : null));
  // re-skin the snapshot with the viewer's chosen unit; readonly components read list.displayUnit
  const roList = computed(() =>
    snapshot.value ? { ...snapshot.value, displayUnit: unit.value } : null,
  );
  const ungrouped = computed(() =>
    snapshot.value ? snapshot.value.items.filter((i) => !i.folderId) : [],
  );
  // a shared list shouldn't show empty folders
  const shownFolders = computed(() =>
    roList.value
      ? roList.value.folders.filter((f) => snapshot.value!.items.some((i) => i.folderId === f.id))
      : [],
  );
  return { unit, totals, roList, ungrouped, shownFolders };
}

// The read-only pages' SEO summary was copy-pasted across /s and /l and already
// drifting. The facet + item/weight assembly and the useSeoMeta shape are identical;
// only three copy fragments differ (the empty-state fallback, the noun, and the CTA),
// selected by `kind`. Returns `facets` so /l can render it in its <head> template.
// Each page keeps its own useHead (noindex on /s, canonical on /l) — that's the one
// genuinely divergent bit.
type ReadonlyKind = "shared" | "public";
const SEO_COPY: Record<ReadonlyKind, { empty: string; noun: string; cta: string }> = {
  shared: {
    empty: "A shared packing list on Mahonia.",
    noun: "a shared packing list",
    cta: "Make your own on Mahonia.",
  },
  public: {
    empty: "A public packing list on Mahonia.",
    noun: "a public packing list",
    cta: "Browse gear lists on Mahonia.",
  },
};

export function useReadonlyListSeo(
  snapshot: Ref<ListSnapshot | null>,
  totals: Ref<Totals | null>,
  kind: ReadonlyKind,
) {
  const copy = SEO_COPY[kind];
  const facets = computed(
    () =>
      [tripTypeLabel(snapshot.value?.tripType), seasonLabel(snapshot.value?.season)].filter(
        Boolean,
      ) as string[],
  );
  const desc = computed(() => {
    if (!snapshot.value || !totals.value) return copy.empty;
    const bits = [`${totals.value.itemCount} items`];
    if (facets.value.length) bits.unshift(facets.value.join(", "));
    if (totals.value.hasWeights) bits.push(`${formatWeightAuto(totals.value.baseMg)} base weight`);
    return `${snapshot.value.title} — ${copy.noun} (${bits.join(" · ")}). ${copy.cta}`;
  });
  useSeoMeta({
    description: () => desc.value,
    ogTitle: () => (snapshot.value ? snapshot.value.title : "Mahonia"),
    ogDescription: () => desc.value,
    ogType: "article",
  });
  return { facets };
}
