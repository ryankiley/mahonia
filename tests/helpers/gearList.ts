// The controller stub the ItemRow component suites mount their row against: every
// method the row can call, as a no-op — except updateItem, which runs the real reducer
// against the suite's snapshot when it hands one over, so a pick or a rename re-renders
// the row the way the live controller would. Five files each carried an identical copy
// of this object; `over` is where a suite says what it is actually about (a recording
// setItemWeight, its own vault dials).
//
// The vault dials rest at "asked, and not banked": ItemRow renders its save button
// against them, and a row that has been asked about and isn't in My Gear is the
// plainest state to render for suites that are not about the vault.
import { ref, type Ref } from "vue";
import { applyOps, type ItemPatch } from "../../shared/ops";
import type { ListSnapshot } from "../../shared/types";

export function gearListStub({
  snapshot,
  ...over
}: { snapshot?: Ref<ListSnapshot>; [k: string]: unknown } = {}) {
  return {
    pendingBlankId: ref<string | null>(null),
    updateItem: (id: string, patch: ItemPatch) => {
      if (snapshot) snapshot.value = applyOps(snapshot.value, [{ t: "updateItem", id, patch }]) as ListSnapshot;
    },
    setItemWeight: () => {},
    removeItem: () => {},
    duplicateItem: () => "",
    moveItem: () => {},
    discardEmpty: () => {},
    addBlankItemAfter: () => "",
    addChild: () => "",
    nestItem: () => {},
    unnest: () => {},
    saveItemToVault: () => Promise.resolve(),
    vaultAuto: ref(false),
    vaultDeclined: ref(new Set<string>()),
    vaultGear: ref(new Map()),
    vaultGearAsked: ref(new Set()),
    vaultGearSettled: ref(true),
    ...over,
  };
}
