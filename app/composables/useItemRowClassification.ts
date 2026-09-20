import type { Ref } from "vue";
import type { Classification, Item, ListSnapshot } from "~~/shared/types";
import { splitWornQty, storedClassification } from "~~/shared/weights";

const MAX_SPLIT_OPTS = 5;

/** The row's base/worn/consumable state machine, including partial worn quantities. */
export function useItemRowClassification({
  item,
  list,
  effectiveClass,
}: {
  item: Readonly<Ref<Item>>;
  list: Readonly<Ref<ListSnapshot>>;
  effectiveClass: Readonly<Ref<Classification>>;
}) {
  const gear = useGearList();
  const activeSplit = computed(() => splitWornQty(item.value, effectiveClass.value));
  const isWorn = computed(() => effectiveClass.value === "worn" || activeSplit.value > 0);
  const isConsumable = computed(() => effectiveClass.value === "consumable");
  const baseValue = (): Classification | null =>
    storedClassification("base", item.value.folderId, list.value.folders);
  function setClass(next: "worn" | "consumable", on: boolean) {
    gear.updateItem(item.value.id, {
      classification: on ? next : baseValue(),
      wornQty: 0,
    });
  }
  function setSplit(n: number) {
    gear.updateItem(item.value.id, {
      wornQty: activeSplit.value === n ? 0 : n,
      classification: baseValue(),
    });
  }
  const splitOptions = computed(() => {
    if (isConsumable.value) return [];
    const counts = new Set<number>();
    for (let n = 1; n <= Math.min(item.value.qty - 1, MAX_SPLIT_OPTS); n++) counts.add(n);
    if (activeSplit.value > 0) counts.add(activeSplit.value);
    return [...counts].sort((a, b) => a - b);
  });
  const wornTitle = computed(() =>
    activeSplit.value > 0 ? `${activeSplit.value} of ${item.value.qty} worn` : "Worn",
  );
  const wornAria = computed(() =>
    activeSplit.value > 0
      ? `Worn: ${activeSplit.value} of ${item.value.qty}`
      : isWorn.value
        ? "Worn: yes"
        : "Worn: no",
  );
  const consumableAria = computed(() => (isConsumable.value ? "Consumable: yes" : "Consumable: no"));
  return { activeSplit, consumableAria, isConsumable, isWorn, setClass, setSplit, splitOptions, wornAria, wornTitle };
}
