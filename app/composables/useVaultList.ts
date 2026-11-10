// My Gear as a surface holds it: the gear page, the list editor's My Gear pane, and the
// edit dialog. Each held its own copy of the load (and two of them already said its
// failure differently) and of the POST every change goes through.
//
// Lazy surfaces only. useVaultAccess is on the editor's first load (ItemRow and
// useGearList ask it whether there is a vault at all); this module is imported by the
// pane, the page and the dialog, which are all chunks of their own.

import type { VaultEntry, VaultItemOp } from "~~/shared/vault";
import { readGearCopy, writeGearCopy } from "../utils/gearCopy";

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
 *
 * Offline it is this device's copy (utils/gearCopy.ts). The copy paints first whenever
 * nothing is on screen yet, so a signed-in load shows the gear before the server
 * answers, and it stands in when the server can't answer: the session ask failed
 * (offline with an account reads "presumed", never signed in) or the gear's own read
 * did. `offline` is that state, and the surfaces go read-only on it: a change to My
 * Gear has no queue the way a list edit does, so each would only fail.
 */
export function useVaultList() {
  const { hasVault, vaultFetch } = useVaultAccess();
  const session = useSession();
  const items = ref<VaultEntry[]>([]);
  const fetching = ref(false);
  const loadError = ref("");
  /** When the gear on screen was read from the server: just now for a fresh answer, the
   *  copy's own time for a copy, null with nothing on screen. What "last updated" says. */
  const readAt = ref<number | null>(null);
  /** An account to show gear for: one the server confirmed, or one this browser has the
   *  hint of while the server can't be asked. Gating on `hasVault` alone asked a
   *  signed-in visitor to sign in whenever they were offline. */
  const hasGear = computed(() => hasVault.value || session.presence.value !== "signedOut");
  // "presumed" with the ask still out is a question; with the ask failed, it is offline
  const asking = computed(() => !hasVault.value && session.presence.value === "presumed" && session.pending.value);
  /** The server can't be asked: the session never answered, or the gear's read failed. */
  const offline = computed(() => hasGear.value && !asking.value && (!hasVault.value || loadError.value !== ""));
  /** Waiting on either answer. */
  const loading = computed(() => fetching.value || asking.value);

  // What the gear surfaces say over the gear while it can't be read fresh, in one place
  // so the page and the pane say it alike. A failed read with no copy keeps the load's
  // own words.
  const now = useNow({ interval: 60_000 });
  const offlineNote = computed(() => {
    if (!offline.value) return "";
    if (readAt.value !== null) return `Offline · last updated ${timeAgo(readAt.value, now.value.getTime())}`;
    return loadError.value || "You’re offline, and this device hasn’t kept a copy of your gear yet.";
  });

  // Whether `items` came from the server, so the copy is only ever written from an answer
  // and never from itself.
  let fresh = false;
  async function load() {
    if (!hasGear.value) {
      fresh = false;
      items.value = [];
      readAt.value = null;
      return;
    }
    if (!items.value.length) {
      const copy = readGearCopy();
      if (copy) {
        fresh = false;
        items.value = copy.items;
        readAt.value = copy.savedAt;
      }
    }
    // presumed: nothing to ask with yet, and offline nothing ever will be; the copy stands in
    if (!hasVault.value) return;
    fetching.value = true;
    loadError.value = "";
    try {
      const got = (await vaultFetch<{ items: VaultEntry[] }>("/api/vault/list")).items || [];
      fresh = true;
      items.value = got;
      readAt.value = Date.now();
    } catch {
      loadError.value = "Couldn’t load your gear. Check your connection and try again.";
    }
    fetching.value = false;
  }
  watch([hasGear, hasVault], () => void load(), { immediate: true });

  // The copy follows every answer: each read, and each change the page saves in place
  // (they splice the row the vault answered with into `items`, so the next offline visit
  // sees the edit without a reload in between).
  watch(
    items,
    (now) => {
      if (fresh && hasVault.value) writeGearCopy(now);
    },
    { deep: true },
  );

  // Back online: ask again. Presumed, the session goes first and its answer flips
  // hasVault, which loads; signed in, the read that failed is simply retried.
  const online = useOnline();
  watch(online, (up) => {
    if (!up || !offline.value) return;
    if (hasVault.value) void load();
    else void session.refresh();
  });

  return { hasVault, hasGear, items, loading, loadError, offline, offlineNote, load };
}
