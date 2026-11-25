import type { Ref } from "vue";
import type { Classification, Item, ListSnapshot } from "~~/shared/types";
import { splitWornQty, storedClassification } from "~~/shared/weights";

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
  /** How many units the row counts as worn — the stepper's value and the popover's count
   *  line. 0 when none are. */
  const wornCount = computed(() => (effectiveClass.value === "worn" ? Math.max(0, item.value.qty) : activeSplit.value));
  /** Whether "how many?" is a question at all: only on a row of several, because one of
   *  one is simply worn, and never on a consumable, which is not worn at any count. */
  const splitOffered = computed(() => !isConsumable.value && item.value.qty > 1);
  /**
   * Set how many of the line are worn: 0 is not worn, the whole count is the Worn class,
   * anything between is a split of a base line. ONE writer for the stepper, the typed
   * figure and "All", clamped to the line, so no control can ask for a count the row
   * does not have. It replaced a row of count chips (1 2 3 4 All) whose ceiling was what
   * fitted the card, not anything about gear.
   *
   * A request for the count the row already has writes NOTHING: every updateItem is a
   * save, a version and a line in the list's history. That is also what keeps a row
   * worn through its FOLDER's default from being stamped with a class of its own when
   * "All" is pressed on it.
   */
  function setWornCount(n: number) {
    const qty = Math.max(0, item.value.qty);
    const next = Math.max(0, Math.min(qty, Math.round(n)));
    if (next === wornCount.value) return;
    if (next >= qty) return setClass("worn", true);
    gear.updateItem(item.value.id, { wornQty: next, classification: baseValue() });
  }
  const wornTitle = computed(() =>
    activeSplit.value > 0 ? `${activeSplit.value} of ${item.value.qty} worn` : "Worn",
  );
  // The two toggles' accessible names say WHICH row, as the stepper's and the grip's do:
  // a list of twenty read "Consumable: no" twenty times. They still open with the word
  // on the tooltip (WCAG 2.5.3), and the state closes the name.
  const named = () => item.value.name || "item";
  const wornAria = computed(() =>
    activeSplit.value > 0
      ? `Worn for ${named()}: ${activeSplit.value} of ${item.value.qty}`
      : `Worn for ${named()}: ${isWorn.value ? "yes" : "no"}`,
  );
  const consumableAria = computed(() => `Consumable for ${named()}: ${isConsumable.value ? "yes" : "no"}`);
  return { activeSplit, consumableAria, isConsumable, isWorn, setClass, setWornCount, splitOffered, wornAria, wornCount, wornTitle };
}
