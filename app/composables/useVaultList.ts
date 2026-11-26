// My Gear as a surface holds it: the gear page, the list editor's My Gear pane, and the
// edit dialog. Each held its own copy of the load (and two of them already said its
// failure differently) and of the POST every change goes through.
//
// Lazy surfaces only. useVaultAccess is on the editor's first load (ItemRow and
// useGearList ask it whether there is a vault at all); this module is imported by the
// pane, the page and the dialog, which are all chunks of their own.

import { isRecord } from "~~/shared/record";
import type { VaultEntry, VaultItemOp } from "~~/shared/vault";
import { recallJson, remember, forget } from "../utils/remember";
import { OWNED, ownedKey, sessionCacheOwner } from "../utils/sessionOwner";

/** What a change answers. Never thrown: a failed request answers `{ ok: false }`, as a
 *  refusal does, and each caller says what failed. */
export type VaultOpResult = { ok: boolean; reason?: string; item?: VaultEntry };

/** Every change to a row (add, edit, kit) is one op; and putting a piece away or back
 *  is its own route. */
export function useVaultOps(
  /** True while a change must not be sent: /gear passes its offline state, so a change
   *  reached some way the hidden controls don't cover (the undo bar, say) is refused
   *  here and answers as a failure the page reports, rather than going out to fail. */
  refuse: () => boolean = () => false,
) {
  const { vaultFetch } = useVaultAccess();
  const op = (o: VaultItemOp): Promise<VaultOpResult> =>
    refuse()
      ? Promise.resolve({ ok: false, reason: "offline" })
      : vaultFetch<VaultOpResult>("/api/vault/items", { method: "POST", body: { op: o } }).catch(() => ({ ok: false }));
  /** Put a piece away (a tombstone, so a list still holding it can't bring it back),
   *  or back. False when the request failed. */
  const remove = (id: number, restore = false): Promise<boolean> =>
    refuse()
      ? Promise.resolve(false)
      : vaultFetch("/api/vault/remove", { method: "POST", body: restore ? { id, restore } : { id } }).then(
          () => true,
          () => false,
        );
  return { op, remove };
}

// ---------------------------------------------------------------------------
// the device's copy
// ---------------------------------------------------------------------------
// My Gear as this device last read it: what /gear and the list's My Gear pane show when
// the server can't be asked. Read and written only here, off every page's first load,
// and dropped with the account's other memos by forgetOwned (sessionOwner.ts), which
// knows it by OWNED.gearCopy.
//
// Keyed per account (ownedKey), never one shared key, and NOT the service worker's
// cache: a cache keyed by URL would hand account A's gear to account B on a shared
// browser offline, where nothing can check who is asking.

/** A copy past this many characters is dropped rather than kept stale: localStorage is
 *  shared with every other memo on the origin. A piece is a few hundred bytes, so this
 *  is thousands of pieces. */
const COPY_MAX_CHARS = 1_500_000;

interface GearCopy {
  items: VaultEntry[];
  /** when it was read from the server, epoch ms */
  savedAt: number;
}

// The fields every surface reads without a guard (the row, the kit arithmetic, the
// search). A copy is read when there is no server to fall back to, so an entry missing
// one (an older shape, a hand-edited value) is dropped rather than left to throw in the
// render and take the whole page down offline.
const isPart = (p: unknown): boolean => isRecord(p) && typeof p.id === "number" && typeof p.qty === "number";
const isEntry = (v: unknown): v is VaultEntry =>
  isRecord(v) &&
  typeof v.id === "number" &&
  typeof v.name === "string" &&
  typeof v.normKey === "string" &&
  typeof v.weightMg === "number" &&
  (v.parts === undefined || (Array.isArray(v.parts) && v.parts.every(isPart)));
const isCopy = (v: unknown): v is { items: unknown[]; savedAt: number } =>
  isRecord(v) && Array.isArray(v.items) && typeof v.savedAt === "number";

/** This account's copy, or null: none kept, no owner to key it by, or unreadable. */
export function readGearCopy(owner: string | null): GearCopy | null {
  const key = ownedKey(OWNED.gearCopy, owner);
  const raw = key ? recallJson(key, isCopy, null) : null;
  return raw ? { items: raw.items.filter(isEntry), savedAt: raw.savedAt } : null;
}

/** Keep the server's latest answer for `owner`, named by the caller: whose gear this is
 *  is a fact about the read that produced it, never about whoever is signed in by the
 *  time it's written. Too big to keep is the same as none. */
export function writeGearCopy(items: VaultEntry[], owner: string | null, now = Date.now()): void {
  const key = ownedKey(OWNED.gearCopy, owner);
  if (!key) return;
  const json = JSON.stringify({ items, savedAt: now } satisfies GearCopy);
  if (json.length > COPY_MAX_CHARS) forget(key);
  else remember(key, json);
}

/**
 * The account's gear, loaded once there is a vault to load and again when that flips
 * (signing in or out mid-session, which the session plugin's watcher drives), and
 * emptied when there isn't one. `loadError` is the load's alone: a change that fails
 * says so in its caller's own words, and a reload after it must not wipe them.
 *
 * Offline it is this device's copy (above). The copy paints first whenever
 * nothing is on screen yet, so a signed-in load shows the gear before the server
 * answers, and it stands in when the server can't answer: the session ask failed
 * (offline with an account reads "presumed", never signed in) or the gear's own read
 * did. `offline` is that state, and the surfaces go read-only on it: a change to My
 * Gear has no queue the way a list edit does, so each would only fail.
 */
export function useVaultList(
  opts: {
    /** Awaited before a server answer that CHANGES what is listed goes on screen: the
     *  list pane holds it until the editor's column has finished moving aside, so the
     *  re-render lands on a still page rather than in the middle of the move. */
    before?: () => Promise<unknown>;
  } = {},
) {
  const { hasVault, vaultFetch } = useVaultAccess();
  const session = useSession();
  const items = ref<VaultEntry[]>([]);
  /** Where `items` came from: nothing yet, this device's copy, or the server. Only a
   *  server answer is ever written back as the copy, and a copy is never edited. */
  const source = ref<"none" | "copy" | "server">("none");
  /** Whose gear `items` is: the owner marker it was loaded under. A sign-in to another
   *  account (in this tab, or in another, which changes the cookie under this one)
   *  doesn't change what's on screen, so the copy is written under this, and only while
   *  the browser is still theirs. */
  let loadedFor: string | null = null;
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
  // Once the server has failed to answer, asking AGAIN doesn't take the offline state
  // down: the retries below would blink the note and the controls every 30 s.
  const wasOffline = ref(false);
  /** The server can't be asked: the session never answered, or the gear's read failed. */
  const offline = computed(
    () => hasGear.value && (!hasVault.value || loadError.value !== "") && (!asking.value || wasOffline.value),
  );
  // `immediate`: a surface opened when the ask has ALREADY failed (the list's pane,
  // opened offline) starts out offline, and that never changes for a plain watcher to
  // see, so the first re-ask blinked it. (clear() below keeps the latch for the same
  // case: the first load runs it.)
  watch(
    offline,
    (off) => {
      if (off) wasOffline.value = true;
    },
    { immediate: true },
  );
  /** Nothing on screen may be changed: offline, or still the copy while the server's
   *  answer is on its way. The copy can be behind an edit made on another device, so a
   *  row of it opened for editing could save over that edit, or edit a piece since put
   *  away. A NEW piece is safe to add meanwhile, so the page keys Add gear on `offline`;
   *  a new kit isn't, its items are picked from these rows. */
  const readonly = computed(() => offline.value || source.value === "copy");
  /** Waiting on either answer. */
  const loading = computed(() => fetching.value || asking.value);

  // What the gear surfaces say over the gear while it can't be read fresh, in one place
  // so the page and the pane say it alike. A failed read with no copy keeps the load's
  // own words. `now` moves only while offline (it is set as offline begins, and the
  // retry below ticks it), which is the only time this is shown.
  const now = ref(Date.now());
  const offlineNote = computed(() => {
    if (!offline.value) return "";
    if (readAt.value !== null) return `Offline · last updated ${timeAgo(readAt.value, now.value)}`;
    return loadError.value || "You’re offline, and this device hasn’t kept a copy of your gear yet.";
  });

  function clear() {
    source.value = "none";
    items.value = [];
    readAt.value = null;
    // The next account's first ask is a question, not the last one's offline answer.
    // With no ask out it is offline already, though, and has to stay latched: nothing
    // about `offline` changes then for the watcher above to set it again, and the first
    // load of a surface opened offline comes through here.
    wasOffline.value = false;
    wasOffline.value = offline.value;
  }

  async function load() {
    if (!hasGear.value) {
      clear();
      loadedFor = null;
      return;
    }
    const who = sessionCacheOwner();
    // another account's gear never stays on screen, and never paints under this one
    if (who !== loadedFor) {
      clear();
      loadedFor = who;
    }
    if (!items.value.length) {
      const copy = readGearCopy(who);
      if (copy) {
        source.value = "copy";
        items.value = copy.items;
        readAt.value = copy.savedAt;
      }
    }
    // presumed: nothing to ask with yet, and offline nothing ever will be; the copy stands in
    if (!hasVault.value) return;
    fetching.value = true;
    let stale = false;
    try {
      const got = (await vaultFetch<{ items: VaultEntry[] }>("/api/vault/list")).items || [];
      // The usual answer is the copy already on screen, and replacing the array with
      // its twin re-rendered every row for nothing. Kept as it is, then; only the
      // copy's date moves, which the items watcher below won't do for an array that
      // didn't change.
      const same = source.value !== "none" && JSON.stringify(got) === JSON.stringify(items.value);
      if (!same) await opts.before?.();
      // Answered for an account this browser no longer holds (a sign-in in another tab
      // changes the cookie under this one, and this tab's session never hears of it):
      // dropped, and asked again for whoever holds it now. Dropping it and stopping
      // left the page on the old copy, read-only, with nothing saying why.
      stale = sessionCacheOwner() !== who;
      if (!stale) {
        source.value = "server";
        if (same) writeGearCopy(items.value, who);
        else items.value = got;
        readAt.value = Date.now();
        // cleared only by an answer, so a retry in flight doesn't blink the offline state
        loadError.value = "";
        wasOffline.value = false;
      }
    } catch {
      loadError.value = "Couldn’t load your gear. Check your connection and try again.";
    }
    fetching.value = false;
    if (stale) await load();
  }
  watch([hasGear, hasVault, () => session.user.value?.owner], () => void load(), { immediate: true });

  // The copy follows every answer: each read, and each change the page saves in place
  // (they splice the row the vault answered with into `items`, so the next offline visit
  // sees the edit without a reload in between). Under the account it was loaded for,
  // and not at all once the browser's cookie names someone else.
  watch(
    items,
    (list) => {
      if (source.value !== "server" || !hasVault.value || loadedFor === null) return;
      if (sessionCacheOwner() === loadedFor) writeGearCopy(list, loadedFor);
    },
    { deep: true },
  );

  // Reading the gear again after a failed read, on useRetryWhile's triggers; each one
  // also moves "last updated".
  //
  // Only the gear's own read. The SESSION'S re-ask, the presumed case, is the session
  // plugin's, once for every surface that waits on it (useSessionReask); its answer
  // flips hasVault, and the watcher above loads.
  if (import.meta.client) watch(offline, (off) => off && (now.value = Date.now()), { immediate: true });
  useRetryWhile(offline, () => {
    now.value = Date.now();
    if (hasVault.value) void load();
  });

  return { hasVault, hasGear, items, loading, loadError, offline, readonly, offlineNote, load };
}
