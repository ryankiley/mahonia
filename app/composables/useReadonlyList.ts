import type { Ref } from "vue";
import type { ListSnapshot, Unit } from "~~/shared/types";
import { computeTotals } from "~~/shared/weights";

// Shared reactive view-model for the two read-only pages (/s/[code] + /l/[slug]):
// a viewer-chosen display unit, the rolled-up totals, the unit-reskinned list the
// readonly components render, and the non-empty folders/ungrouped split. The two
// pages differ only in chrome (SEO/report on /l, live-poll on /s) — the data
// shaping is identical and lives here so it can't drift.
export function useReadonlyList(snapshot: Ref<ListSnapshot | null>) {
  const unit = ref<Unit>(snapshot.value?.displayUnit ?? "g");
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
