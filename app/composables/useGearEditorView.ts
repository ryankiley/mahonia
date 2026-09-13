import type { Ref } from "vue";
import type { Unit } from "~~/shared/types";
import { tripHeadline } from "~~/shared/trailDistance";
import { formatWeight, computeTotals, groupItemsByFolder, groupItemsByParent, ungroupedTopLevel, bySortOrder } from "~~/shared/weights";
import { chipWeightLabels, filterItemsForPerson, hasUnassignedTopLevel, personName, personSlot, selectionGone, sortedPeople, UNASSIGNED } from "~~/shared/people";
import { countedForPacking } from "~~/shared/packing";
import { variantShownIds } from "~~/shared/variantShown";

/**
 * The editor-wide derived view of a list.
 *
 * Folder/row grouping, person filtering, the headline, and packing progress are
 * data-model concerns shared by the editor chrome. The component keeps the layout,
 * provides the resulting row tables, and owns every dialog and visual transition.
 */
export function useGearEditorView({
  flash,
  askConfirm,
}: {
  flash: (message: string) => void;
  askConfirm: (options: { title: string; message: string; confirmLabel: string }) => Promise<boolean>;
}) {
  const controller = useGearList();
  const snapshot = controller.snapshot;
  const totals = controller.totals;
  const { mode, everPlan, switching: modeSwitching } = useEditorMode();
  const packed = computed(() => mode.value === "pack");

  const ungrouped = computed(() =>
    snapshot.value ? ungroupedTopLevel(snapshot.value.items) : [],
  );
  const sortedFolders = computed(() =>
    snapshot.value ? [...snapshot.value.folders].sort(bySortOrder) : [],
  );
  const itemsByFolder = computed(() => groupItemsByFolder(snapshot.value?.items ?? []));
  const childrenByParent = computed(() => groupItemsByParent(snapshot.value?.items ?? []));
  const variantShown = computed(() => variantShownIds(snapshot.value?.items ?? []));

  const personFilter = usePersonFilter();
  const people = computed(() => sortedPeople(snapshot.value?.people));
  const personSlotById = computed(() => new Map(people.value.map((p, i) => [p.id, i])));
  const peopleOpen = ref(false);
  const hasUnassigned = computed(() => hasUnassignedTopLevel(snapshot.value?.items ?? []));
  watch([people, hasUnassigned, () => snapshot.value?.shareCode], ([, , code], [, , oldCode]) => {
    const selected = personFilter.selected.value;
    if (!selected) return;
    const emptied =
      code === oldCode && selected === UNASSIGNED && people.value.length > 0 && !hasUnassigned.value;
    if (!selectionGone(people.value, hasUnassigned.value, selected)) return;
    personFilter.clear();
    if (emptied) flash("Everything’s assigned");
  });
  const personFilterAttr = computed(() => {
    const selected = personFilter.selected.value;
    if (!selected) return null;
    if (selected === UNASSIGNED) return "u";
    const slot = personSlot(snapshot.value?.people, selected);
    return slot == null ? null : String(slot);
  });
  const filteredItems = computed(() =>
    filterItemsForPerson(snapshot.value?.items ?? [], personFilter.selected.value),
  );
  const view = computed(() => {
    const list = snapshot.value;
    if (!list || !personFilter.selected.value) return { list, totals: totals.value };
    const items = filteredItems.value;
    return { list: { ...list, items }, totals: computeTotals({ folders: list.folders, items }) };
  });
  const filterCaption = computed(() => {
    const selected = personFilter.selected.value;
    if (!selected || mode.value === "plan") return undefined;
    if (selected === UNASSIGNED) return "Unassigned gear";
    const name = personName(snapshot.value?.people, selected);
    return name ? `${name}’s pack` : undefined;
  });
  const chipWeights = computed<Record<string, string> | undefined>(() => {
    const list = snapshot.value;
    if (!list || !totals.value?.hasWeights || !people.value.length) return undefined;
    return chipWeightLabels(list, list.displayUnit);
  });
  const emptyFilterName = computed(() => {
    const selected = personFilter.selected.value;
    if (!selected || selected === UNASSIGNED || filteredItems.value.length) return null;
    return personName(snapshot.value?.people, selected) ?? null;
  });
  const headline = computed(() => {
    if (mode.value === "plan") {
      const trip = tripHeadline(snapshot.value ?? {});
      return {
        value: trip.value,
        unit: trip.unit as string,
        options: DISTANCE_UNIT_OPTIONS,
        label: "Distance unit",
        triggerLabel: `${trip.value} ${trip.unit}, change unit`,
        pick: (unit: string) => controller.setMeta({ trailDistanceUnit: unit }),
      };
    }
    const unit = snapshot.value?.displayUnit ?? "g";
    const value = formatWeight(view.value.totals?.totalMg ?? 0, unit, { withUnit: false });
    return {
      value,
      unit: unit as string,
      options: WEIGHT_UNIT_OPTIONS,
      label: "Weight unit",
      triggerLabel: `${value} ${unit}, change unit`,
      pick: (next: string) => controller.setUnit(next as Unit),
    };
  });
  const packProgress = computed(() => {
    const items = countedForPacking(filteredItems.value, snapshot.value?.items ?? []);
    return { done: items.filter((item) => item.packed).length, total: items.length };
  });
  const anyPacked = computed(() => filteredItems.value.some((item) => item.packed));
  async function clearChecks() {
    if (!snapshot.value) return;
    if (!(await askConfirm({
      title: "Clear checks",
      message: "Uncheck every packed item? Your gear stays. Only the check marks reset.",
      confirmLabel: "Clear checks",
    }))) return;
    if (!snapshot.value) return;
    for (const item of filteredItems.value)
      if (item.packed) controller.updateItem(item.id, { packed: false });
  }

  return {
    anyPacked,
    childrenByParent,
    chipWeights,
    clearChecks,
    emptyFilterName,
    everPlan,
    filteredItems,
    filterCaption,
    hasUnassigned,
    headline,
    itemsByFolder,
    mode,
    modeSwitching,
    packed,
    packProgress,
    people,
    peopleOpen,
    personFilter,
    personFilterAttr,
    personSlotById,
    sortedFolders,
    ungrouped,
    variantShown,
    view,
  };
}
