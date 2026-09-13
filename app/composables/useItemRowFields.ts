import type { Ref } from "vue";
import type { Item, ListSnapshot, Unit } from "~~/shared/types";
import { effectiveClassification, formatWeight, fromMg, groupLineMg, itemDisplayName, rowDisplayKcal } from "~~/shared/weights";
import { isWaterName, waterLiters, waterMgFromMl } from "~~/shared/water";

const STEP_BY_UNIT: Record<Unit, number> = { g: 1, kg: 0.01, oz: 0.1, lb: 0.1 };
export const QTY_MAX = 9999;
const clampQty = (n: number) => Math.max(1, Math.min(QTY_MAX, Math.round(n)));

/**
 * The row's editable measurements and their canonical writes.
 *
 * This is deliberately independent of the row's presentation: ItemRow owns focus,
 * popovers, nesting, and the DOM fields; this model owns the unit/quantity/water
 * invariants that every one of those controls reads or writes.
 */
export function useItemRowFields({
  item,
  list,
  children,
  isParent,
  onAdvance,
  fitNote,
}: {
  item: Readonly<Ref<Item>>;
  list: Readonly<Ref<ListSnapshot>>;
  children: Readonly<Ref<Item[]>>;
  isParent: Readonly<Ref<boolean>>;
  onAdvance: () => void;
  fitNote: () => void;
}) {
  const gear = useGearList();
  const rowUnit = computed(() => item.value.entryUnit ?? list.value.displayUnit);
  const weightDisplay = computed(() =>
    item.value.unitWeightMg > 0
      ? formatWeight(item.value.unitWeightMg, rowUnit.value, { withUnit: false })
      : "",
  );
  const groupWeight = computed(() =>
    formatWeight(groupLineMg(item.value, children.value), rowUnit.value, { withUnit: false }),
  );
  const rowKcal = computed(() => rowDisplayKcal(item.value, children.value, list.value.folders));
  const effClass = computed(() => effectiveClassification(item.value, list.value.folders));
  const editableName = computed(() => itemDisplayName(item.value.brand, item.value.name));

  const isWater = computed(() => isWaterName(item.value.name));
  const litersDisplay = computed(() => waterLiters(item.value.unitWeightMg));
  function onWaterLiters(e: Event) {
    const el = e.target as HTMLInputElement;
    const liters = Math.max(0, Number(el.value) || 0);
    gear.updateItem(item.value.id, {
      unitWeightMg: waterMgFromMl(liters * 1000),
      weightOverridden: true,
    });
    el.value = litersDisplay.value;
  }

  function onWeight(e: Event) {
    if (isWater.value || isParent.value) return;
    const el = e.target as HTMLInputElement;
    if (!el.value.trim().startsWith("<")) gear.setItemWeight(item.value.id, el.value);
    el.value = weightDisplay.value;
  }
  function onWeightKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.isComposing || isWater.value || isParent.value) return;
    e.preventDefault();
    (e.target as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
    onAdvance();
  }
  function onWeightFocus(e: Event) {
    const el = e.target as HTMLInputElement;
    if (el.value.trim().startsWith("<")) el.select();
  }
  function onRowUnit(u: Unit) {
    gear.updateItem(item.value.id, { entryUnit: u });
  }

  function onQty(e: Event) {
    const el = e.target as HTMLInputElement;
    const qty = clampQty(Number(el.value) || 1);
    gear.updateItem(item.value.id, { qty });
    el.value = String(qty);
  }
  const qtyFieldRef = useTemplateRef<HTMLInputElement>("qtyFieldRef");
  const qtyPopping = ref(false);
  function popQty() {
    qtyPopping.value = false;
    nextTick(() => {
      void qtyFieldRef.value?.offsetHeight;
      qtyPopping.value = true;
    });
  }
  function stepQty(dir: 1 | -1) {
    const next = clampQty(item.value.qty + dir);
    if (next === item.value.qty) return;
    gear.updateItem(item.value.id, { qty: next });
    popQty();
  }

  function onCommonName(e: Event) {
    const el = e.target as HTMLInputElement;
    gear.updateItem(item.value.id, { commonName: el.value, commonNameOverridden: true });
    el.value = item.value.commonName ?? "";
  }
  function onVariant(e: Event) {
    const el = e.target as HTMLInputElement;
    gear.updateItem(item.value.id, { variant: el.value, nameOverridden: true });
    el.value = item.value.variant ?? "";
  }
  function onNote(e: Event) {
    const el = e.target as HTMLTextAreaElement;
    gear.updateItem(item.value.id, { description: el.value });
    el.value = item.value.description ?? "";
    fitNote();
  }
  function onWeightStep(e: KeyboardEvent, dir: 1 | -1) {
    if (isWater.value || isParent.value) return;
    const unit = rowUnit.value;
    const step = (STEP_BY_UNIT[unit] ?? 1) * (e.shiftKey ? 10 : 1);
    const current = fromMg(item.value.unitWeightMg, unit);
    const next = Math.max(0, Number((current + dir * step).toFixed(unit === "g" ? 0 : 2)));
    gear.setItemWeight(item.value.id, String(next));
    (e.target as HTMLInputElement).value = weightDisplay.value;
  }

  return {
    editableName,
    effClass,
    groupWeight,
    isWater,
    litersDisplay,
    onCommonName,
    onNote,
    onQty,
    onRowUnit,
    onVariant,
    onWaterLiters,
    onWeight,
    onWeightFocus,
    onWeightKeydown,
    onWeightStep,
    qtyFieldRef,
    qtyPopping,
    rowKcal,
    rowUnit,
    stepQty,
    weightDisplay,
  };
}
