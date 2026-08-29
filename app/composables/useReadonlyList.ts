import type { Ref } from "vue";
import { seasonLabel, tripTypeLabel } from "~~/shared/discovery";
import {
  carriedTotalsMg,
  filterItemsForPerson,
  hasUnassignedTopLevel,
  sortedPeople,
  UNASSIGNED,
  visibleItemsForPerson,
  type PersonSelection,
} from "~~/shared/people";
import type { ListSnapshot, Totals, Unit } from "~~/shared/types";
import {
  bySortOrder,
  computeTotals,
  formatWeight,
  formatWeightAuto,
  ungroupedTopLevel,
  unitSystem,
} from "~~/shared/weights";

// Shared reactive view-model for the two read-only pages (/s/[code] + /l/[slug]):
// a viewer-chosen display unit, a viewer-chosen person filter, the rolled-up
// totals, the reskinned list the readonly components render, and the non-empty
// folders/ungrouped split. The two pages differ only in chrome (SEO/report on
// /l, live-poll on /s) — the data shaping is identical and lives here so it
// can't drift.
export function useReadonlyList(snapshot: Ref<ListSnapshot | null>) {
  // Shared read-only views always START in grams — they deliberately DON'T inherit
  // the owner's saved displayUnit, so a shared link reads the same for everyone
  // regardless of the unit the owner happens to edit in. The viewer can still
  // toggle the unit locally (below); that choice is never persisted.
  const unit = ref<Unit>("g");
  // Who the viewer is narrowed to (Matt opening the link taps himself) — viewer
  // state like `unit`, so never persisted, and reset when the page moves on to a
  // different list under the same component instance.
  const personFilter = ref<PersonSelection>(null);
  watch(() => snapshot.value?.shareCode, () => (personFilter.value = null));
  const people = computed(() => sortedPeople(snapshot.value?.people));
  const showUnassigned = computed(() => hasUnassignedTopLevel(snapshot.value?.items ?? []));
  // /s polls live, so the owner can pull the filtered person (or claim the last
  // unclaimed row) out from under a viewer — widen a selection that stopped
  // resolving, exactly as the editor's watcher does, or the viewer is stranded
  // on a blank list under a chips row with nothing lit and no tab stop.
  watch([people, showUnassigned], () => {
    const s = personFilter.value;
    if (!s) return;
    const gone =
      s === UNASSIGNED
        ? !people.value.length || !showUnassigned.value
        : !people.value.some((p) => p.id === s);
    if (gone) personFilter.value = null;
  });
  // two readings of the filter, per shared/people.ts: the rows the page RENDERS
  // (matches plus a parent kept as context around a matching child) and the rows
  // a person's totals COUNT (strict — a context parent's own line is someone
  // else's weight)
  const visibleItems = computed(() =>
    visibleItemsForPerson(snapshot.value?.items ?? [], personFilter.value),
  );
  // the whole list's totals, filter or no filter — what SEO/unfurls must describe
  // (a share preview is about the list, not about whichever chip a viewer tapped)
  const fullTotals = computed(() => (snapshot.value ? computeTotals(snapshot.value) : null));
  // each chip's carry, in the viewer's unit — absent until the list has weights
  const chipWeights = computed<Record<string, string> | undefined>(() => {
    const s = snapshot.value;
    if (!s || !fullTotals.value?.hasWeights) return undefined;
    const out: Record<string, string> = {};
    for (const [key, mg] of Object.entries(carriedTotalsMg(s))) out[key] = formatWeight(mg, unit.value);
    return out;
  });
  const totals = computed<Totals | null>(() => {
    if (!snapshot.value) return null;
    if (!personFilter.value) return fullTotals.value;
    return computeTotals({
      folders: snapshot.value.folders,
      items: filterItemsForPerson(snapshot.value.items, personFilter.value),
    });
  });
  // re-skin the snapshot with the viewer's unit + filter; readonly components read
  // list.displayUnit and list.items, so this is the one place both choices apply
  const roList = computed(() =>
    snapshot.value
      ? { ...snapshot.value, displayUnit: unit.value, items: visibleItems.value }
      : null,
  );
  // top-level ungrouped rows only — nested children render under their parent
  // (the same predicate the editor uses, so the two views can't drift)
  const ungrouped = computed(() => ungroupedTopLevel(visibleItems.value));
  // a shared list shouldn't show empty folders (one Set pass, not an
  // items.some() scan per folder); sorted by sortOrder because array order is
  // insertion order — folder drag-reorder only rewrites sortOrder. Built from the
  // VISIBLE items, so a folder holding nothing of the filtered person's stands
  // down whole, as it does in the editor.
  const shownFolders = computed(() => {
    if (!roList.value) return [];
    const withItems = new Set(visibleItems.value.map((i) => i.folderId));
    return roList.value.folders.filter((f) => withItems.has(f.id)).sort(bySortOrder);
  });
  return { unit, totals, fullTotals, roList, ungrouped, shownFolders, people, personFilter, showUnassigned, chipWeights };
}

// The read-only pages' SEO summary was copy-pasted across /s and /l and already
// drifting. The facet + item/weight assembly and the useSeoMeta shape are identical;
// only three copy fragments differ (the empty-state fallback, the noun, and the CTA),
// selected by `kind`. Returns `facets` so /l can render it in its <head> template.
// Each page keeps its own useHead (noindex on /s, canonical on /l) — that's the one
// genuinely divergent bit.
type ReadonlyKind = "shared" | "public";
const SEO_COPY: Record<
  ReadonlyKind,
  { empty: string; noun: string; cta: string; cardPath: (s: ListSnapshot) => string }
> = {
  shared: {
    empty: "A shared packing list on Mahonia.",
    noun: "a shared packing list",
    cta: "Make your own on Mahonia.",
    cardPath: (s) => `/og/s/${s.shareCode}`,
  },
  public: {
    empty: "A public packing list on Mahonia.",
    noun: "a public packing list",
    cta: "Browse gear lists on Mahonia.",
    cardPath: (s) => `/og/l/${s.slug}`,
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
    // owner's system, matching the card image beside this text — the UNFURL
    // reads as the owner presents it; only the page starts in grams (the rule
    // at the top of this file). See ogCardModel for the policy note.
    if (totals.value.hasWeights)
      bits.push(
        `${formatWeightAuto(totals.value.baseMg, { system: unitSystem(snapshot.value.displayUnit) })} base weight`,
      );
    return `${snapshot.value.title}, ${copy.noun} (${bits.join(" · ")}). ${copy.cta}`;
  });
  // the card IMAGE — rendered per list by /og/s|/og/l, addressed by the same
  // capability as the page itself; tag assembly lives in useListOgCard
  useListOgCard(() =>
    snapshot.value && totals.value
      ? { path: copy.cardPath(snapshot.value), list: snapshot.value, totals: totals.value }
      : null,
  );
  useSeoMeta({
    description: () => desc.value,
    ogTitle: () => (snapshot.value ? snapshot.value.title : "Mahonia"),
    ogDescription: () => desc.value,
    ogType: "article",
  });
  return { facets };
}
