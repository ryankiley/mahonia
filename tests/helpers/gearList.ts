// The controller stub the ItemRow component suites mount their row against: every
// method the row can call, as a no-op — except updateItem, which runs the real reducer
// against the suite's snapshot when it hands one over, so a pick or a rename re-renders
// the row the way the live controller would. Five files each carried an identical copy
// of this object; `over` is where a suite says what it is actually about (a recording
// setItemWeight, its own vault dials).
//
// The vault dials rest UNASKED — `vaultGearAsked` is empty, so no key has an answer
// yet. ItemRow reads that as covered (`if (!vaultGearAsked.value.has(key)) return true`)
// and renders no save button at all, which is the quietest state for the four suites
// that are not about the vault. It is NOT "asked and not banked", which is the state
// that renders a live button — itemVaultButton wants that one and populates
// `vaultGearAsked` itself, which is exactly why it has to.
import { ref, type Ref } from "vue";
import type { LocalListRecord } from "../../shared/localList";
import { applyOps, type ItemPatch } from "../../shared/ops";
import type { ListSnapshot } from "../../shared/types";

/**
 * The controller surface ItemRow touches — the KEYS a suite may override.
 *
 * `Partial<Record<keyof …, unknown>>` rather than `Partial<GearListStub>`: the values
 * are deliberately unchecked, because the base is built from no-ops whose inferred
 * types (`() => void`, `Ref<Set<never>>`) are narrower than what a real suite hands
 * back — a recording setItemWeight returns a number, itemVaultButton's saveItemToVault
 * is a Mock of CaptureOneResult, its vaultGear is a ReadonlyMap. Typing the values off
 * the no-ops rejected every one of those.
 *
 * The KEY check is the part that matters and the part that was missing: with the bare
 * `[k: string]: unknown` index signature this replaced, a typo ("setItemWeigth")
 * type-checked, added a dead property and left the no-op default in force — so the
 * suite asserted against the stub's silence instead of against its own override.
 */
type GearListKey = keyof ReturnType<typeof baseStub>;

function baseStub(snapshot?: Ref<ListSnapshot>) {
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
    pasteItemsAfter: () => "",
    addChild: () => "",
    nestItem: () => {},
    unnest: () => {},
    saveItemToVault: () => Promise.resolve(),
    vaultAuto: ref(false),
    vaultDeclined: ref(new Set<string>()),
    vaultGear: ref(new Map()),
    vaultKits: ref(new Set<string>()),
    vaultGearAsked: ref(new Set()),
    vaultGearSettled: ref(true),
  };
}

export function gearListStub(
  { snapshot, ...over }: Partial<Record<GearListKey, unknown>> & { snapshot?: Ref<ListSnapshot> } = {},
) {
  return { ...baseStub(snapshot), ...over };
}

// ---- the two boundaries the live controller is stubbed at ------------------------
// These are what the stubbed composables RETURN. `mockNuxtImport` is a compile-time
// macro whose factory is hoisted above this file's imports and run the moment anything
// touches `#imports`, so a factory may not call an import eagerly — each file writes
// `mockNuxtImport("useVaultAccess", () => () => quietVaultAccess())`, and the helper is
// reached only when the composable is actually called, long after imports settled.
// What moved here is the object, which a dozen files had each spelled out by hand.

/** A device with no vault, and the session already answered — so capture stays quiet
 *  and every vault read settles at once instead of waiting on /api/auth/me. The state
 *  for a suite the vault is not the subject of. */
export const quietVaultAccess = () => ({
  hasVault: ref(false),
  vaultKnown: ref(true),
  vaultFetch: <T,>() => Promise.resolve({} as T),
});

/** A device WITH a vault whose search answers `results` — handed over as the live
 *  array, so a case can push a hit into it after the mock is built. */
export const vaultWithHits = (results: unknown[]) => ({
  hasVault: ref(true),
  vaultKnown: ref(true),
  vaultFetch: () => Promise.resolve({ results }),
});

/**
 * useLocalListStore's IndexedDB, in memory. With a Map it RECORDS: writes deep-copy
 * exactly as the real store does (it JSON round-trips to strip Vue's reactive proxy),
 * so a test can never accidentally assert against a live reference to the controller's
 * own state. Without one it is a sink — for suites about the optimistic snapshot the
 * reducer builds, where what reaches the device is nobody's business.
 */
export const memoryListStore = (records?: Map<string, LocalListRecord>) => ({
  get: async (key: string) => records?.get(key),
  set: async (key: string, record: LocalListRecord) => {
    records?.set(key, JSON.parse(JSON.stringify(record)));
  },
  del: async (key: string) => {
    records?.delete(key);
  },
});
