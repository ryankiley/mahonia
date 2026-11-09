// My Gear as a surface holds it: the gear page, the list editor's My Gear pane, and the
// edit dialog. Each held its own copy of the load (and two of them already said its
// failure differently) and of the POST every change goes through.
//
// Lazy surfaces only. useVaultAccess is on the editor's first load (ItemRow and
// useGearList ask it whether there is a vault at all); this module is imported by the
// pane, the page and the dialog, which are all chunks of their own.

import type { VaultEntry, VaultItemOp } from "~~/shared/vault";

/** What a change answers. Never thrown: a failed request answers `{ ok: false }`, as a
 *  refusal does, and each caller says what failed. */
export type VaultOpResult = { ok: boolean; reason?: string; item?: VaultEntry };

/** Every change to a row (add, edit, kit) is one op; and putting a piece away or back
 *  is its own route. */
export function useVaultOps() {
  const { vaultFetch } = useVaultAccess();
  const op = (o: VaultItemOp): Promise<VaultOpResult> =>
    vaultFetch<VaultOpResult>("/api/vault/items", { method: "POST", body: { op: o } }).catch(() => ({ ok: false }));
  /** Put a piece away (a tombstone, so a list still holding it can't bring it back),
   *  or back. False when the request failed. */
  const remove = (id: number, restore = false): Promise<boolean> =>
    vaultFetch("/api/vault/remove", { method: "POST", body: restore ? { id, restore } : { id } }).then(
      () => true,
      () => false,
    );
  return { op, remove };
}

/**
 * The account's gear, loaded once there is a vault to load and again when that flips
 * (signing in or out mid-session, which the session plugin's watcher drives), and
 * emptied when there isn't one. `loadError` is the load's alone: a change that fails
 * says so in its caller's own words, and a reload after it must not wipe them.
 */
export function useVaultList() {
  const { hasVault, vaultFetch } = useVaultAccess();
  const items = ref<VaultEntry[]>([]);
  const loading = ref(false);
  const loadError = ref("");
  async function load() {
    if (!hasVault.value) {
      items.value = [];
      return;
    }
    loading.value = true;
    loadError.value = "";
    try {
      items.value = (await vaultFetch<{ items: VaultEntry[] }>("/api/vault/list")).items || [];
    } catch {
      loadError.value = "Couldn’t load your gear. Check your connection and try again.";
    }
    loading.value = false;
  }
  watch(hasVault, () => void load(), { immediate: true });
  return { hasVault, items, loading, loadError, load };
}
