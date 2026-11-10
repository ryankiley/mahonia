import type { Op } from "~~/shared/ops";
import { applyOps, tidyListText, rebaseOnto } from "~~/shared/ops";
import { uid } from "~~/shared/id";
import { colorKeyForName, STARTER_FOLDERS, usedColorKeys } from "~~/shared/categories";
import { LIST_CODE_HEADER, editLinkPath, normalizeShareCode } from "~~/shared/links";
import { DRAFT_KEY, claimedLocalKey, hasRealContent, localKey } from "~~/shared/localList";
import { reconcileSnapshot } from "~~/shared/reconcile";
import type { Folder, Item, ListSnapshot } from "~~/shared/types";
import { pickListMeta } from "~~/shared/types";
import type { CaptureOneResult } from "./useVault";
import type { VaultCapture, VaultGearKey } from "~~/shared/vault";
import { listNormKeys } from "~~/shared/vault";
import { computeTotals, lineMg } from "~~/shared/weights";
import { isWaterName } from "~~/shared/water";
import { createEdits } from "~/composables/useGearListEdits";
import { forgetClaimedOpen, markClaimedOpen } from "~/composables/useClaimedLists";
import { useUndo } from "~/composables/useUndo";

// Editor controller (one list open at a time → module singleton). Mutations are
// applied optimistically via the SAME op-reducer the server uses, queued, and
// flushed (debounced). A poll pulls other editors' merged changes live. The queue
// is mirrored to IndexedDB (useLocalListStore) so a draft or an un-acked edit
// survives a reload, a crash, or a dropped connection.

// "missing" is the one state only a new open leaves: the server has no row under this
// capability (deleted, the link rotated, the claim revoked), so nothing the network does
// can change the answer. A local copy may still be on screen, readable and exportable;
// edits to it persist to IndexedDB only, never queued or flushed against a dead row.
type Status = "idle" | "loading" | "saving" | "synced" | "missing" | "error" | "offline";

/** What this open holds, which is what every request and every local key hangs off.
 *  "none" is a draft, or nothing open. "token" is an edit link on this device. "claimed"
 *  is the share code of a list on the signed-in account, the session being the proof
 *  (server/utils/editAuth). "keyless" is a fragment-less /e/{code} with no session: the
 *  link lost its edit key, so all it can offer is the read view (startKeyless). */
type ListAccess =
  | { kind: "none" }
  | { kind: "token"; token: string }
  | { kind: "claimed"; code: string }
  | { kind: "keyless"; code: string };

/** The question a list you didn't start puts to you about its gear: the toast, then on
 *  a yes the chooser. One at a time, or none. */
type VaultAsk = { step: "prompt"; title: string } | { step: "picker"; rows: VaultCapture[] };

/** How long after a dispatch the queued ops go to the server. Long enough that a burst
 *  of keystrokes is one request; short enough that a list closed a moment after an
 *  edit has usually already flushed. */
const FLUSH_DEBOUNCE_MS = 450;
/** The first wait after a failed flush; it doubles per failure to a 30 s ceiling. */
const FLUSH_BACKOFF_MS = 1500;
// Both read at the moment the timer is set — for tests. The suites that drive this
// controller with real timers (tests/gearList.nuxt.test.ts and company) wait out the
// flush debounce on nearly every case, and the backoff once.
let flushDebounceMs = FLUSH_DEBOUNCE_MS;
let flushBackoffMs = FLUSH_BACKOFF_MS;
/** Shorten the flush debounce, or restore the default — a test seam. Only the wait
 *  changes: the queue, the in-flight guard and the rebase run as they do at 450 ms. */
export function _setFlushDebounce(ms = FLUSH_DEBOUNCE_MS): void {
  flushDebounceMs = ms;
}
/** Shorten the first retry wait after a failed flush, or restore the default — a test
 *  seam. The doubling and the 30 s ceiling are untouched. */
export function _setFlushBackoff(ms = FLUSH_BACKOFF_MS): void {
  flushBackoffMs = ms;
}

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const snapshot = ref<ListSnapshot | null>(null);
  const status = ref<Status>("idle");
  // a freshly "Add an item" row that's still empty — it autofocuses on mount and
  // discards itself if you click away without typing (so the list isn't littered)
  const pendingBlankId = ref<string | null>(null);
  const access = shallowRef<ListAccess>({ kind: "none" });
  const editToken = () => (access.value.kind === "token" ? access.value.token : "");
  const claimCode = () => (access.value.kind === "claimed" ? access.value.code : "");
  /** Whether this open reaches a server row, by either way in. Not a draft, not keyless. */
  const holdsList = () => access.value.kind === "token" || access.value.kind === "claimed";
  // the chrome hides the token-only affordances (Forget, the copyable edit link) on a
  // claimed open, and the keyless page offers the read view of this code
  const openedByCode = computed(() => access.value.kind === "claimed");
  const keylessCode = computed(() => (access.value.kind === "keyless" ? access.value.code : ""));
  let pending: Op[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  // The failure path's own timer, kept apart from flushTimer so a backoff already
  // counting down can be cancelled on teardown rather than firing into a session that
  // has moved on. Its delay grows with flushFailures, which any successful flush zeroes.
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let flushFailures = 0;
  let inFlight = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  // when the list last showed a sign of life — a local edit, a change adopted from
  // elsewhere, a field taking focus, the tab coming back — sets the poll cadence
  let liveAt = 0;
  let isEditing = false;
  const remoteMissing = () => status.value === "missing";
  /** Every status move within a session, which is all of them but the four that begin
   *  one (load, startDraft, startKeyless, dispose). The server's verdict stands until
   *  then: a load and a flush can overlap, and a later answer from the other one doesn't
   *  overrule it, or everything reading it goes back to queuing against a dead row. */
  function setStatus(next: Status) {
    if (!remoteMissing()) status.value = next;
  }
  // bumped on every load/dispose so in-flight responses for a previous list are ignored
  let epoch = 0;
  // The same count as a ref, for a consumer that has to REACT to the list changing
  // rather than compare once after an await — the route import's held pin offer,
  // which outlives a `dispose(); startDraft()` that never unmounts ListHead.
  const epochRef = shallowRef(0);
  function bumpEpoch(): number {
    epochRef.value = ++epoch;
    return epoch;
  }
  // True while load() runs its one-time backfills (water names, folder colours,
  // stranded children). Those go through dispatch like any edit — which is right for
  // persistence, and wrong for the vault: they fire on OPEN, so a list someone
  // shared with you would capture its owner's whole gear set into your vault the
  // moment a single legacy folder needed a colour. Suppressed here rather than at
  // each backfill, so a fourth one added later inherits the rule instead of
  // reintroducing the leak.
  let hydrating = false;
  // Raised when gear would reach the vault from a list this device didn't create
  // and hasn't been answered for. The editor shows it as a toast; nothing is
  // captured until it's answered, and the answer is remembered per list.
  const vaultAsk = shallowRef<VaultAsk | null>(null);
  const vaultPrompt = computed(() => (vaultAsk.value?.step === "prompt" ? vaultAsk.value : null));
  // the rows the chooser is offering, or null when it's closed
  const vaultPicker = computed(() => (vaultAsk.value?.step === "picker" ? vaultAsk.value.rows : null));
  // Whether the AUTOMATIC capture path is on for this list (the stored answer is
  // "yes"), and which rows the chooser declined. The stored truth lives in
  // localStorage, which nothing can react to — so it's mirrored into refs here,
  // re-read by refreshVaultCover() at every point the answer (or the token it's
  // keyed by) changes. ItemRow renders against these: a row the automatic path
  // already banks shows its save button as already banked rather than offering
  // to do what's done.
  const vaultAuto = ref(false);
  const vaultDeclined = shallowRef<ReadonlySet<string>>(new Set());
  function refreshVaultCover() {
    vaultAuto.value = vaultDecisionFor(editToken()) === "yes";
    vaultDeclined.value = vaultExclusionsFor(editToken());
  }

  // ---- what My Gear already holds, OF THIS LIST'S GEAR --------------------
  //
  // The other half of what a row's save button needs, and the half no local
  // answer can supply: the vault either has this piece of gear or it doesn't,
  // however it got there — a list on another device, an import, a row typed by
  // hand on /gear. The per-list answers above are about CAPTURE, and reading them
  // as membership is what made the button offer to save gear banked months ago.
  //
  // PER LIST, and that is the point. This was an app-wide, app-lifetime cache
  // once; two reviews of it produced 27 findings, about twenty of which were
  // consequences of that one choice — an epoch to tell one account's answer from
  // the next, a reset hooked into sign-out, a merge rule for a read racing a
  // capture, two timeouts, a sequence counter. State that dies with the list it
  // describes needs none of them: `resetSession()` drops it, and the next list
  // asks its own question.
  //
  // `gear` is what the vault holds of the keys we ASKED about — value is the
  // weight a capture could still write, or null when that weight is pinned and no
  // capture may argue with it. `asked` is which keys we have an answer for at
  // all, and it is the reason both exist: "the vault doesn't have this" and "we
  // haven't asked yet" are the same empty Map, and rendering the second as the
  // first is the flash PR #239 took out of the signed-in first paint.
  const vaultGear = shallowRef<ReadonlyMap<string, number | null>>(new Map());
  const vaultGearAsked = shallowRef<ReadonlySet<string>>(new Set());
  // ...and which of those keys My Gear holds as a KIT. A group row reads this rather
  // than the weight map: it is covered when the vault holds the set, not when it
  // holds a piece of the same name — a piece of that name is exactly what pressing
  // the group's save turns into the set (see captureKit).
  const vaultKits = shallowRef<ReadonlySet<string>>(new Set());
  /** The two readings of one answer, kept together so they can't drift: the weight
   *  a capture could still write per key, and the keys that are kits. */
  function readGearKeys(found: VaultGearKey[]) {
    return {
      gear: new Map(found.map(([k, w]) => [k, w] as const)),
      kits: new Set(found.filter((f) => f[2] === "kit").map((f) => f[0])),
    };
  }
  /** Whether an ask has SETTLED for this list — true even when it found nothing,
   *  and even when there was nothing to ask about. Only the reveal animation
   *  needs it; coverage reads `asked`, which is finer. */
  const vaultGearSettled = ref(false);
  /** Forget the vault's answer about the last list's gear — on a new list, and when
   *  the account under the vault changes. */
  function clearVaultGear() {
    vaultGear.value = new Map();
    vaultKits.value = new Set();
    vaultGearAsked.value = new Set();
    vaultGearSettled.value = false;
  }
  // newest ask wins: opens overlap, and a slower older answer landing last would
  // revert a fresher one
  let vaultGearGen = 0;
  let vaultGearTimer: ReturnType<typeof setTimeout> | undefined;
  /** How long after an edit to ask about gear the list has gained. Long enough
   *  that typing a name is one ask rather than one per keystroke. */
  const VAULT_GEAR_DEBOUNCE_MS = 700;

  /** Every distinct gear identity in the list right now. Not the capture set —
   *  this is about what a ROW might render, so it includes rows capture would
   *  skip, and it costs one fold per item rather than the capture builder's pass. */
  function listGearKeys(): string[] {
    const snap = snapshot.value;
    return snap ? [...listNormKeys(snap.items)] : [];
  }

  /**
   * Ask the vault about this list's gear.
   *
   * Skips the request when every key already has an answer, so the debounced
   * re-ask after an edit costs nothing until the list actually gains gear.
   * `force` is for the one case where the answers are still about the wrong
   * question: the session changed under an open list.
   *
   * Never throws, and never makes a signed-out visitor wait. The editor is
   * prerendered and most visitors have no account, so the hint cookie — a
   * synchronous read, no round trip — settles them immediately with nothing
   * banked, which is exactly right and keeps them off this endpoint entirely.
   * A failed or slow ask settles the same way: the button then stands where it
   * did before any of this existed, rather than staying hidden behind a request
   * that may never land.
   */
  async function askVaultGear(force = false): Promise<void> {
    if (!import.meta.client) return;
    const keys = listGearKeys();
    const gen = ++vaultGearGen;
    const settle = (found: VaultGearKey[]) => {
      if (gen !== vaultGearGen) return; // a newer ask (or a new list) owns the answer
      const read = readGearKeys(found);
      vaultGear.value = read.gear;
      vaultKits.value = read.kits;
      vaultGearAsked.value = new Set(keys);
      vaultGearSettled.value = true;
    };
    if (!force && keys.every((k) => vaultGearAsked.value.has(k))) {
      vaultGearSettled.value = true;
      return;
    }
    // Two ways to know there is nothing to ask, and neither costs a round trip.
    // Once the session has answered, "signed out" is final. Before it answers, the
    // hint cookie stands in: the editor is prerendered and most visitors have no
    // account, and a request on every one of their page loads is exactly the cost
    // that cookie exists to avoid (see useSession.refresh).
    if (!keys.length) return settle([]);
    if (sessionKnown.value ? !sessionHasVault.value : sessionPresence.value === "signedOut") return settle([]);
    try {
      const res = await vaultRead<{ keys: VaultGearKey[] }>("/api/vault/among", {
        method: "POST",
        body: { normKeys: keys },
        // $fetch has no timeout of its own, so a socket that never answers (a
        // captive portal, a dead radio) would hold every save button back until
        // the browser gave up minutes later
        signal: AbortSignal.timeout(6_000),
      });
      settle(Array.isArray(res?.keys) ? res.keys : []);
    } catch {
      settle([]); // signed out, offline, rate-limited — see the header
    }
  }

  /** Re-ask after the list has settled from an edit — only actually a request
   *  when the list gained gear nothing has answered for. */
  function queueVaultGear(): void {
    clearTimeout(vaultGearTimer);
    vaultGearTimer = setTimeout(() => void askVaultGear(), VAULT_GEAR_DEBOUNCE_MS);
  }

  /** Fold gear this device has just banked into the answer, so the button stands
   *  down without another round trip — and so a DUPLICATE of that gear further
   *  down the same list stops offering too. Only ever keys the server confirmed
   *  are live (see captureOne). */
  function noteVaultGear(landed: VaultGearKey[]): void {
    if (!landed.length) return;
    const gear = new Map(vaultGear.value);
    const kits = new Set(vaultKits.value);
    const asked = new Set(vaultGearAsked.value);
    for (const [k, w, kind] of landed) {
      gear.set(k, w);
      // a key that landed as a kit is one now; one that landed as a piece isn't
      if (kind === "kit") kits.add(k);
      else kits.delete(k);
      asked.add(k);
    }
    vaultGear.value = gear;
    vaultKits.value = kits;
    vaultGearAsked.value = asked;
  }
  let teardownListeners: (() => void) | undefined;

  // on-device durability + connectivity awareness. The connectivity ref + watcher
  // live in a DETACHED effect scope so they track for the singleton's whole life,
  // not just while the editor component happens to be mounted (this controller
  // outlives any single mount).
  const store = useLocalListStore();
  const scope = effectScope(true);
  // The vault's capture side. Bound inside the controller's scope so its
  // page-hide flush lives exactly as long as the editor does.
  const vault = useVaultCapture();
  scope.run(() => vault.bindFlushOnLeave());
  // The ONE thing a per-list answer cannot work out for itself: signing in (or
  // out) without leaving the list. Nothing reopens the list, so nothing would
  // re-ask, and the answers on screen would still be about the last session —
  // which for a sign-in means every row falls back to the capture proxy and
  // offers to save gear the new account banked months ago. That was finding #1 of
  // the first review, and it is the whole reason this watcher exists.
  //
  // In the controller's scope, which already outlives any single mount, so it
  // needs no lifetime machinery of its own.
  // Resolved once, HERE: askVaultGear runs from a debounce and from async
  // continuations, and the session state underneath vaultFetch is a useState.
  // It is also the seam the codebase keeps every vault call behind, so a call
  // site can't forget the credential.
  const { vaultFetch: vaultRead, hasVault: sessionHasVault, vaultKnown: sessionKnown } =
    useVaultAccess();
  // presence is the three-way answer askVaultGear gates on before the session has
  // resolved (a cookie read, not a request); signedIn is the RESOLVED one, read where
  // a 401 on a claimed open has to be told apart from a session that merely lapsed
  // (load's catch).
  const { presence: sessionPresence, signedIn: sessionSignedIn } = useSession();
  // The device's registry and the account's list, resolved once: syncRegistry and its
  // gate run on every dispatch, and building a handle each time (useClaimedLists
  // builds useSession's computeds with it) was a keystroke's worth of allocation.
  const myLists = useMyLists();
  const claimedLists = useClaimedLists();
  scope.run(() => {
    watch(sessionHasVault, (has) => {
      clearVaultGear();
      void askVaultGear(true);
      // capture stands down while signed out (useVault's sync), so a sign-in on an
      // open list is the first chance its gear has had
      if (has) captureIfMine();
    });
  });
  const online = scope.run(() => useOnline())!;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  // The IndexedDB slot this open persists under: the edit token, a code-prefixed
  // key for a claimed open, or the draft slot before first save.
  const storeKey = () => (access.value.kind === "claimed" ? claimedLocalKey(access.value.code) : localKey(editToken()));

  // Write the current snapshot + queue to IndexedDB under this list's key.
  // Best-effort: the store swallows its own failures, so this never throws into
  // the edit path. No-ops with no snapshot.
  function writeLocal() {
    if (!snapshot.value) return;
    store.set(storeKey(), {
      snapshot: snapshot.value,
      pending: pending.slice(),
      updatedAt: Date.now(),
    });
  }

  // Mirror to IndexedDB, debounced — local writes are cheap but frequent (every
  // keystroke dispatches an op).
  function persistLocal() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(writeLocal, 200);
  }

  // Going offline surfaces honestly; coming back online drains whatever the offline
  // gate held back (a never-saved draft's create, or a saved list's queued ops).
  scope.run(() => {
    watch(online, (isOnline) => {
      if (!isOnline) {
        if (snapshot.value && status.value !== "loading") setStatus("offline");
        return;
      }
      if (!snapshot.value) {
        // A launch that found no copy on the device and no network to load from:
        // the network is back, so load it now — the address never changed, only
        // the answer.
        if (status.value === "offline") retryLoad();
        return;
      }
      if (remoteMissing()) return; // still dead server-side: nothing to drain or poll
      if (!holdsList()) {
        if (hasRealContent(snapshot.value)) createFromDraft();
      } else if (pending.length) {
        scheduleFlush();
      } else if (status.value === "offline") {
        setStatus("synced");
      }
      // the network coming back is the tab coming back, as far as the poll is
      // concerned: whatever happened elsewhere while it was gone is worth showing
      // now, not wherever the idle cadence had got to
      if (holdsList()) wakePoll(true);
    });
  });

  // single-level undo for destructive removes — drives the editor's UndoBar, on the
  // timer My Gear's uses too (useUndo). `verb` is what the bar says happened to
  // `label`: removes, its first tenant, say nothing and read "Removed"; a paste that
  // made rows says "Added" (pasteItemsAfter).
  const undo = useUndo();
  function offerUndo(label: string, restore: () => void, verb?: "Added" | "Removed") {
    undo.offer({ label, restore, verb });
  }
  // Something just ADDED as a set (a kit from My Gear, unfolded into a group): offer to
  // take it back off. The group's row goes and its rows with it (the reducer's
  // cascade), with no "Removed" of its own — undoing an add means it was never there.
  function offerUndoAdd(label: string, parentId: string) {
    offerUndo(label, () => dispatch({ t: "removeItem", id: parentId }), "Added");
  }

  const totals = computed(() =>
    snapshot.value ? computeTotals(snapshot.value) : null,
  );

  // The write capability, as request headers. Two shapes, matching the server's
  // one gate (editAuth): the bearer token when this device holds the edit link,
  // else the claimed list's code — the session cookie rides along on its own and
  // is the part that actually proves anything.
  function authHeaders() {
    const token = editToken();
    if (token) return { Authorization: `Bearer ${token}` } as Record<string, string>;
    return { [LIST_CODE_HEADER]: claimCode() } as Record<string, string>;
  }

  // Keep this list's row in "Your lists" in step with the snapshot. Called after a
  // sync — which is where the server's version number comes from — AND optimistically
  // from dispatch, because the list switcher reads the REGISTRY, not the snapshot.
  // A list you just renamed has to answer to its new name in the dropdown straight
  // away, not one debounce plus a round-trip later; the reducer here is the same one
  // the server runs, so the title we write is already the title it will store.
  //
  // dispose() is what makes that more than a latency question. It fires its last
  // flush blind and discards the response, so a rename made on the way out of the
  // editor — typed, then straight into the switcher to open another list — reached
  // the server but never reached the row, and the old name sat in the dropdown until
  // that list was opened again.
  function syncRegistry() {
    if (!snapshot.value) return;
    const patch = {
      title: snapshot.value.title,
      version: snapshot.value.version,
      totalMg: totals.value?.totalMg ?? 0, // the memoized rollup — no fresh full-list pass
      displayUnit: snapshot.value.displayUnit, // keep the summary in the list's unit system
    };
    const held = access.value;
    if (held.kind === "token") myLists.touch(held.token, patch);
    // a claimed open has no registry row — its switcher row reads the account
    // list, so a rename here has to reach THAT copy to show up in the dropdown
    else if (held.kind === "claimed") {
      claimedLists.touchByCode(held.code, patch);
      // ...and the registry row is also where touch() stamps lastOpened, which is
      // how the bare address knows where you left off. A claimed open has nowhere
      // to stamp it, so it goes in the ledger beside the row copy. Here rather
      // than only on a confirmed load, because this is the path an OFFLINE open
      // takes: hydrated from the on-device copy with no server to confirm
      // anything, and still every bit "the list you had open". Not once the server
      // HAS answered that the claim is dead, though: the hydrate stamp lands before
      // that answer, and every device-only edit on the dead-end page would renew it
      // — the bare address then offered the dead list first on every launch.
      if (!remoteMissing()) markClaimedOpen(held.code);
    }
  }

  // The gate on that optimistic call. dispatch runs on every keystroke and touch()
  // REASSIGNS the registry array (which persists the whole registry), so this asks
  // first whether anything the row actually shows has moved — for most edits, nothing
  // has. No row at all — a draft with no token yet, or a list removed from this
  // device — means nothing to update: touch is update-only by design, and re-adding
  // one here would undo a "Remove from device". Version is deliberately not compared;
  // an optimistic op never moves it, only the server does.
  function registryStale() {
    if (!snapshot.value) return false;
    const held = access.value;
    const row =
      held.kind === "token"
        ? myLists.entries.value.find((e) => e.editToken === held.token)
        : held.kind === "claimed"
          ? claimedLists.lists.value.find((l) => l.shareCode === held.code)
          : undefined;
    if (!row) return false;
    return (
      row.title !== snapshot.value.title ||
      row.displayUnit !== snapshot.value.displayUnit ||
      row.totalMg !== (totals.value?.totalMg ?? 0)
    );
  }

  // Add this list to the device's "Your lists" (upsert, not touch), so a list
  // opened from an edit link — one someone shared with you, or your own link
  // opened on a second device — is remembered here, not only lists this browser
  // created/imported/cloned. Called ONLY after the server has confirmed the token
  // (load's authed fetch below), so a bad or rotated token never mints a dead
  // entry; the local-hydrate path keeps using touch (update-only) for that reason.
  // No new exposure: by the time we're here the token IS the on-device IndexedDB
  // key and load() has already persisted the snapshot there — this just surfaces a
  // visible handle. "Remove from device" (forget) still wins: the edit-path syncs
  // stay touch, so a list you removed mid-session isn't silently re-added.
  function registerOpened() {
    if (!snapshot.value) return;
    // A claimed open has no token to register and never gets a registry row; its
    // row copy and its ledger stamp are syncRegistry's, and a first open on this
    // device has no on-device copy for the hydrate path to have run it on — so it
    // runs here, on the server's fresh title and total, the way registerCreated
    // below refreshes a token's row.
    if (claimCode()) {
      syncRegistry();
      return;
    }
    const token = editToken();
    if (!token) return;
    // registerCreated owns the snapshot→MyListEntry mapping — one source of truth.
    // Marked "opened", because this is the path where a list arrives via a link
    // someone SENT you: signing in must not quietly attach it to your account.
    // upsert keeps a prior "created" if you made this list yourself and are merely
    // reopening it, so your own lists aren't downgraded by coming back to them.
    myLists.registerCreated(
      { editToken: token, snapshot: snapshot.value },
      totals.value?.totalMg ?? 0,
      "opened",
    );
    // The token is the way into this list from now on: the row just minted is what
    // the bare address ranks and how it navigates. A ledger entry from an earlier
    // open through the account would only resurface — ranked at that older time —
    // the moment the row is deleted or removed from this device.
    forgetClaimedOpen(snapshot.value.shareCode);
  }

  // Everything one list's session owns, zeroed. Every way a session begins or ends
  // — load(), startDraft(), dispose() — runs this AFTER `access` is set for the new
  // session, and sets `status` right after it, so a queue, an in-flight flag or a
  // backoff from the last list can never leak into the next one.
  function resetSession() {
    // the previous list's poll chain ends here, not when its next tick happens to
    // notice: a tick still queued from the old session would otherwise fire into
    // this one, and a load() that fails never starts a chain of its own to replace it
    stopPoll();
    pending = [];
    inFlight = false;
    isEditing = false;
    // the vault question is about THIS list — an unanswered one must not ride
    // along to the next list opened (where it would ask about the wrong gear,
    // and spend that list's one chance to ask), and the chooser it opens, left
    // standing, would show the last list's gear over this one and record the answer
    // against this list's token. A draft is yours, and never asks.
    vaultAsk.value = null;
    // ...and the rows must render against THIS list's answer (a draft's answer IS
    // yes: no token → yours by definition)
    refreshVaultCover();
    // The vault's answer was about the LAST list's gear. It dies here, which is
    // the entire lifetime story now: no epoch, no reset hook, no cross-account
    // question — a new list asks its own.
    clearVaultGear();
    vaultGearGen++;
    clearTimeout(vaultGearTimer);
    clearTimeout(flushTimer);
    clearTimeout(retryTimer); // a backoff must not fire into the session that replaced this one
    flushFailures = 0;
  }

  // Open a list this device holds the edit link for ({ token }), or one the
  // signed-in account has claimed ({ code } — the share code, with the session
  // cookie as the proof; see server/utils/editAuth). Token wins if both arrive,
  // matching the server's precedence: it's the more specific claim, and it keeps a
  // signed-in user's behaviour on a shared link identical to a signed-out user's.
  async function load(cap: { token?: string; code?: string }) {
    const myEpoch = bumpEpoch();
    const token = cap.token ?? "";
    // normalized so a hand-typed /e/{code} URL and the canonical code the server
    // returns key the same IndexedDB record and claimed-lists row
    const code = normalizeShareCode(cap.code);
    access.value = token ? { kind: "token", token } : code ? { kind: "claimed", code } : { kind: "none" };
    resetSession();
    snapshot.value = null;
    status.value = "loading";
    installListeners();

    // Hydrate from this browser's local copy first — instant paint, and the only
    // thing we can show if the network is down. Restore its un-acked queue too.
    // When the editor page read ahead (readAhead, below) the copy is usually already
    // here and nothing is awaited: the list lands in this tick, before the editor
    // renders. A read that outran the page's wait is awaited rather than repeated.
    const ahead = store.take(storeKey());
    const local = ahead?.landed ? ahead.landed.record : await (ahead?.read ?? store.get(storeKey()));
    if (myEpoch !== epoch) return; // a newer load() superseded this one
    if (local) {
      // Backfilled on the way in, matching what the server does on the way out
      // (rowToSnapshot). This copy is the FIRST paint and, offline, the only one — an
      // old list cached before the tidy existed would otherwise show straight
      // apostrophes until the network answered, then visibly re-spell itself.
      snapshot.value = tidyListText(local.snapshot);
      pending = local.pending ?? [];
      setStatus(pending.length ? "saving" : "synced");
      syncRegistry();
      // The rows are on screen now, so the question they render against is live
      // now. Silent and best-effort: it decides whether a save button shows, and
      // a list must never wait on it (see askVaultGear).
      void askVaultGear();
    }

    try {
      const res = await $fetch<{ snapshot: ListSnapshot }>("/api/edit/list", {
        headers: authHeaders(),
      });
      if (myEpoch !== epoch) return;
      // server is authoritative; replay any un-acked local ops on top of it
      const merged = rebaseOnto(res.snapshot, pending);
      snapshot.value = merged;
      setStatus(pending.length ? "saving" : "synced");
      registerOpened(); // server confirmed the token → remember this list in "Your lists"
      // A second ask, which costs a request only if the server's copy brought
      // gear the on-device one didn't have — every key already answered for is
      // skipped inside.
      void askVaultGear();
      // NO capture on open. It used to happen here, to catch a list that arrived
      // whole (imported, cloned) and dispatches no ops — but an edit link is an
      // edit link, and this hook could not tell YOUR list opened on a second device
      // from one a friend shared with you. So opening a shared list copied its
      // owner's gear into the opener's vault, and minted a vault for someone who
      // had never asked for one. The whole-list cases capture at the moment they're
      // CREATED instead (useVaultCapture().captureNewList), where the device knows
      // it made the thing; everything else still captures as you edit.
      hydrating = true;
      // one-time cleanups: early water rows were named "Water · 1 L"; the volume now
      // lives in the litres field, so the name should just be "Water". And water is a
      // volume, not a count (foldWaterQty, shared/ops): a row stored with qty 3 before
      // the reducer folded it becomes its whole volume at qty 1, weighing what it did.
      for (const it of merged.items) {
        if (/^water\s*·/i.test(it.name)) updateItem(it.id, { name: "Water" });
        else if (isWaterName(it.name) && it.qty > 1) updateItem(it.id, { qty: 1, unitWeightMg: lineMg(it) });
      }
      // one-time backfill: lists imported before folders got colours assigned have
      // every folder on the neutral grey ("other"), so the category chart reads as
      // all grey. Reassign distinct palette hues — same logic as addFolder — so the
      // viz is colourful. "other" is never auto-assigned and has no picker, so the
      // only folders carrying it came from a pre-colour import; recolouring is safe
      // and self-persists via the mutate flow (covers existing prod lists on open).
      const colorKeys = usedColorKeys(merged.folders);
      merged.folders.forEach((f, i) => {
        if (colorKeys[i] !== "other") return;
        const colorKey = colorKeyForName(f.name, colorKeys);
        colorKeys[i] = colorKey;
        updateFolder(f.id, { colorKey });
      });
      // one-time heal: before the reducer cascaded folderId on cross-folder parent
      // moves (shared/ops.ts moveItem), a dragged parent could strand its children's
      // folderId in the old folder — skewing class totals and folder-delete scope.
      // A same-place moveItem on the parent is a pure no-op for the parent itself
      // and re-runs the cascade; self-persists via the mutate flow like the
      // backfills above.
      const stranded = new Set<Item>();
      const itemById = new Map(merged.items.map((item) => [item.id, item]));
      for (const it of merged.items) {
        if (it.parentId == null) continue;
        const parent = itemById.get(it.parentId);
        if (parent && parent.folderId !== it.folderId) stranded.add(parent);
      }
      for (const p of stranded)
        dispatch({ t: "moveItem", id: p.id, folderId: p.folderId, sortOrder: p.sortOrder });
      hydrating = false;
      // Upgrade a legacy bare /e#{token} URL to the share-ready pretty path
      // (/e/{shareCode}#{token}) once the share code is known. Pre-#54 lists —
      // every bookmark and my-lists entry from before the pretty links shipped —
      // otherwise keep the bare form forever, and the ADDRESS BAR is what people
      // actually copy into Apple Notes/iMessage: the bare /e head is deliberately
      // generic, so those pastes never unfurled the list name (#54's SSR head
      // only exists at /e/{shareCode}). replaceState, not routing, so the hash
      // watcher doesn't dispose/reload us (same pattern as createFromDraft).
      if (
        typeof location !== "undefined" &&
        location.pathname === "/e" &&
        editToken() &&
        merged.shareCode
      ) {
        history.replaceState(history.state, "", editLinkPath(merged.shareCode, editToken()));
      }
      persistLocal();
      if (pending.length) scheduleFlush();
      startPoll();
    } catch (e: any) {
      if (myEpoch !== epoch) return;
      // 404: the server has no list under this capability (deleted, the link
      // rotated — or, for a claimed open, the claim revoked). 401 on a claimed
      // open is its sibling: the session lapsed or never covered this code, and
      // retrying can't fix either. Both land in the same honest dead-end. A
      // 401 on the TOKEN path stays out of here — a bearer is always presented,
      // so a 401 there is a server hiccup worth treating as transient.
      if (statusOf(e) === 404 || (statusOf(e) === 401 && claimCode())) {
        // If we still hold a local copy, keep it on screen so the data is
        // readable/exportable, but don't poll or flush against a dead capability —
        // and don't claim "synced": later edits stay device-only.
        setStatus("missing");
        // A dead token whose list ALSO has a live row in the registry is the
        // leftover half of a rotate — the switcher was showing that pack twice,
        // both rows marked current, and this is the one that no longer opens.
        // Only the row goes; the local copy on screen is untouched (see the
        // composable). The live-side heal is upsert's share-code claim, so it
        // takes one visit to either row, whichever you happened to pick.
        if (editToken()) myLists.forgetSuperseded(editToken());
        // The claimed twin: the stamp the hydrate path made must not outlive the
        // server's verdict, or the bare address resumes into this dead list on
        // every launch. Only while the session is KNOWN good, though — a 401 here
        // says "no claim under this session", and with the session itself
        // unresolved (offline, or still being asked) that is as likely the session
        // as the claim. Forgetting on that reading lost where you left off for a
        // list the account still holds; a truly dead claim is pruned by the next
        // read of the account's rows regardless (pruneClaimedOpens).
        else if (claimCode() && sessionSignedIn.value) forgetClaimedOpen(claimCode());
      } else if (local) {
        // Network failure with a local copy: keep editing, sync when it returns.
        setStatus("offline");
        if (pending.length) scheduleFlush();
        startPoll();
      } else {
        // No copy on the device and no answer from the server. Offline, that is the
        // honest state — "offline" with nothing to show — and the network coming
        // back loads the list on its own (the online watcher); anything else is an
        // error the page offers to retry. Either way the page says so, where it
        // used to sit on "Loading…" for good.
        setStatus(online.value ? "error" : "offline");
      }
    }
  }

  // "Has content" — the gate on persisting a draft at all — is hasRealContent in
  // shared/localList, shared with the sync line so both read the same rule.

  /** Load the list this session names again — after a load that found no copy on
   *  the device and no server: the online watcher calls it when the network returns,
   *  the page's "Try again" by hand. A draft names nothing, so it is a no-op there. */
  function retryLoad(): void {
    if (editToken()) void load({ token: editToken() });
    else if (claimCode()) void load({ code: claimCode() });
  }

  // A fragment-less /e/{code} from a visitor with no session: the link lost its edit
  // key, so nothing here can open the list for editing, and no request is worth
  // making. Same honest dead-end as a dead token, minus the fetch; the page used to
  // mint a fresh draft under the dead address, which read as "the list is empty".
  // The code is kept so the page can offer the read-only view it also opens.
  function startKeyless(code: string) {
    bumpEpoch();
    access.value = { kind: "keyless", code };
    resetSession();
    installListeners();
    snapshot.value = null;
    status.value = "missing";
  }

  // Open a fresh, NOT-yet-persisted list (starter folders, no items). It lives only
  // in memory until the first real content lands (createFromDraft), so a visitor who
  // never adds anything never creates a server row.
  function startDraft() {
    const myEpoch = bumpEpoch();
    access.value = { kind: "none" };
    resetSession();
    installListeners();
    // A draft has no gear to ask about yet; settle it so nothing renders as
    // held-back, and let the debounce above ask once rows arrive.
    void askVaultGear();
    const folders: Folder[] = STARTER_FOLDERS.map((p, i) => ({
      id: uid(),
      name: p.name,
      colorKey: p.colorKey,
      defaultClassification: p.defaultClassification,
      sortOrder: i,
    }));
    snapshot.value = {
      // Empty, not "Untitled list": the title input is a page heading now, and an
      // unnamed draft should show its ghosted placeholder rather than a literal string
      // you have to select and delete before typing. Anything that reaches the server
      // still lands as "Untitled list" (createList), so slugs and "Your lists" are
      // unchanged — the blank only exists while the draft is unnamed.
      title: "",
      description: "",
      displayUnit: "g",
      folders,
      items: [],
      shareCode: "",
      slug: "",
      version: 0,
    };
    status.value = "synced";
    // Restore an in-progress, never-saved draft if one survived a reload/crash.
    // Async (IndexedDB), so the fresh starter paints first and is replaced if found.
    store.get(DRAFT_KEY).then((local) => {
      if (myEpoch !== epoch || editToken() || !local) return;
      snapshot.value = tidyListText(local.snapshot); // same backfill as the token path
      // not local.pending: a draft's queue is what was typed while a create was out,
      // and the snapshot saved beside it already holds every one of those edits —
      // carried over, the create's success would replay them (see its catch)
      pending = [];
      setStatus("synced");
      // a restored draft that already has real content resumes its create attempt
      if (hasRealContent(local.snapshot)) createFromDraft();
    });
  }

  // Persist a draft to the server on its first real content. The created snapshot
  // keeps the client-side folder/item ids (the create path normalizes but preserves
  // ids), so adopting it doesn't disturb focus or references. Ops typed during the
  // round-trip are queued and flushed right after.
  async function createFromDraft() {
    // a claimed open is a SAVED list too — letting it fall through here would mint a
    // duplicate of it under a fresh token
    if (inFlight || holdsList() || !snapshot.value) return;
    // offline: the draft is already persisted locally; create once back online
    if (!online.value) { setStatus("offline"); return; }
    const myEpoch = epoch;
    inFlight = true;
    // the flush's rule: once the line reads "Not saved", a retry doesn't flip it to
    // "Syncing…" and back — that strobes once per attempt and says nothing new
    if (status.value !== "error") setStatus("saving");
    try {
      const s = snapshot.value;
      const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>("/api/lists/create", {
        method: "POST",
        body: {
          // every meta field — a trail link added to the draft must survive its
          // first save, and so must the dates, which sit in the same meta row and
          // are set the same way; LIST_META_KEYS is what keeps the next one from
          // being forgotten here
          ...pickListMeta(s),
          data: { folders: s.folders, items: s.items, days: s.days ?? [], waypoints: s.waypoints ?? [], people: s.people ?? [] },
        },
      });
      if (myEpoch !== epoch) {
        // Landed after the editor moved on (rotate's rule): the list exists now, and its
        // edit link is in this answer and nowhere else. It goes into Your lists so it can
        // be found, and the draft that made it is let go, or the next New list would
        // restore it and make the list twice. Not while a draft is open by now: that
        // record is its own.
        const token = myLists.registerCreated(res);
        setVaultDecisionFor(token, "yes");
        if (!snapshot.value || holdsList()) store.del(DRAFT_KEY);
        return;
      }
      flushFailures = 0;
      clearTimeout(retryTimer);
      access.value = { kind: "token", token: res.editToken };
      const merged = res.snapshot;
      if (pending.length) applyOps(merged, pending); // edits made mid-create
      snapshot.value = merged;
      setStatus("synced");
      // the draft is now a real list — move its on-device record onto the token key
      store.del(DRAFT_KEY);
      persistLocal();
      // register the write capability + put the token in the URL WITHOUT routing
      // (replaceState, so the editor's hash watcher doesn't dispose/reload us)
      const token = myLists.registerCreated(res, totals.value?.totalMg ?? 0);
      setVaultDecisionFor(token, "yes"); // you built it; it's yours without asking
      refreshVaultCover(); // the answer moved onto the new token; keep the mirror true
      // pretty path (/e/{shareCode}#{token}) so the URL is share-ready immediately;
      // replaceState (not routing) so the hash watcher doesn't dispose/reload us
      if (typeof history !== "undefined")
        history.replaceState(history.state, "", editLinkPath(res.snapshot.shareCode, token));
      startPoll();
    } catch {
      if (myEpoch !== epoch) return;
      // `pending` on a draft holds only what was typed while this create was out, and
      // all of it is already IN the snapshot the next create sends whole. Left queued,
      // the next success replayed it over everything typed since: a weight changed
      // after the failure went back to its mid-create value, a deleted row came back.
      pending = [];
      setStatus("error");
      // retry while there's still un-persisted content, backing off the way a failing
      // flush does (and on the same timer, so a list switch cancels it)
      retryAfterBackoff(() => {
        if (!holdsList() && snapshot.value && hasRealContent(snapshot.value)) createFromDraft();
      });
    } finally {
      if (myEpoch === epoch) {
        inFlight = false;
        if (editToken() && pending.length) scheduleFlush();
      }
    }
  }

  function dispatch(op: Op) {
    if (!snapshot.value) return;
    wakePoll(); // an edit here is the surest sign the list is live
    // optimistic: same reducer as the server. The in-place mutation through the
    // deep ref's proxy gives precise property-level reactivity — only the touched
    // rows re-render, so a keystroke in one folder doesn't repaint every folder.
    applyOps(snapshot.value, [op]);
    persistLocal(); // mirror to IndexedDB so this edit survives a reload/crash
    // and mirror to the device registry, which is what the list switcher reads —
    // gated, because this runs on every keystroke (see registryStale/syncRegistry)
    if (registryStale()) syncRegistry();
    // Every mutation funnels through here, whatever made it — typing, a catalog
    // pick, a drag, an undo — so this one call captures gear from all of them
    // without each call site having to remember to.
    if (!hydrating) captureIfMine();
    // ...and the same for the READ side: gear typed in after the list opened has
    // no answer yet, so a row that IS in My Gear would offer to save it — the
    // original bug, in miniature, on rows added since. Debounced, and a no-op
    // unless the list actually gained an identity nothing has answered for.
    if (!hydrating) queueVaultGear();
    // Draft (no capability yet): keep edits local until there's real content, then
    // create the list once. While that create is in flight, queue ops for the
    // post-create flush. A claimed open is NOT a draft — it queues and flushes
    // below exactly like a token-held list.
    if (!holdsList()) {
      if (inFlight) pending.push(op);
      else if (hasRealContent(snapshot.value)) createFromDraft();
      return;
    }
    // the server row is gone (deleted/rotated token) — edits stay on-device only
    if (remoteMissing()) return;
    pending.push(op);
    scheduleFlush();
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, flushDebounceMs);
  }

  /** Run `run` after the failure backoff: the first wait doubled per failure in a row,
   *  to a 30 s ceiling. One timer for a failed flush and a failed create alike. */
  function retryAfterBackoff(run: () => void) {
    flushFailures++;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(run, Math.min(flushBackoffMs * 2 ** (flushFailures - 1), 30_000));
  }

  async function flush() {
    if (inFlight || remoteMissing() || !pending.length || !snapshot.value) return;
    // offline: leave the queue intact + persisted; the online watcher re-flushes
    if (!online.value) { setStatus("offline"); persistLocal(); return; }
    const myEpoch = epoch;
    // Captured for the orphan-recovery write in the catch — by the time it runs,
    // dispose() may already have cleared both of these.
    const myKey = storeKey();
    const snapAtFlush = snapshot.value;
    // ≤500 ops per request — the server 400s on oversized batches instead of
    // truncating. A longer queue (offline session) drains across sequential
    // flushes: the finally reschedules while pending is non-empty, and the
    // rebase below re-applies the remainder onto each merged snapshot.
    const ops = pending.splice(0, 500);
    inFlight = true;
    let failed = false;
    // DON'T ANNOUNCE A RETRY. Once the line reads "Not saved", flipping it to
    // "Syncing…" and back for every attempt is a strobe rather than information — the
    // state worth reporting is "your edits haven't landed", and that stays true until
    // one does. A failing save used to swap the word (and its full-ink alert colour)
    // about once a second for as long as the failure lasted.
    if (status.value !== "error") setStatus("saving");
    // the link this batch goes out under, for the 404 below to tell a dead list from one
    // whose link was replaced while the batch was out
    const sentWith = editToken();
    try {
      const res = await $fetch<{ snapshot: ListSnapshot }>("/api/edit/mutate", {
        method: "POST",
        headers: authHeaders(),
        body: { ops },
      });
      if (myEpoch !== epoch) return; // controller moved to a different list
      if (!isEditing && snapshot.value) {
        // adopt the authoritative merged snapshot, then re-apply ops queued while
        // this request was in flight (rebase) so nothing is lost or clobbered.
        // Patched INTO the live snapshot rather than swapped in for it: a swap
        // re-rendered every row after every settled edit (see shared/reconcile).
        const merged = res.snapshot;
        if (pending.length) applyOps(merged, pending);
        reconcileSnapshot(snapshot.value, merged);
      }
      // While mid-edit: keep local content AND do NOT advance the local version,
      // so the post-blur poll (since < server version) still delivers the merge.
      setStatus("synced");
      flushFailures = 0; // anything landing means the next failure starts its backoff fresh
      syncRegistry();
      persistLocal(); // snapshot adopted + queue drained → update the on-device copy
    } catch (e: any) {
      if (myEpoch !== epoch) {
        // The controller moved to a different list (SPA nav out of the editor, or
        // a switch between two of your lists) WHILE this batch was in flight — and
        // the batch then failed, so these ops reached no server. They're also gone
        // from `pending`: the splice above removed them, and `pending` now belongs
        // to whatever list the controller moved on to, so re-queueing them here
        // would graft them onto the wrong list.
        //
        // Worse, dispose() has already rewritten THIS list's on-device record with
        // the post-splice (empty) queue — so without this they'd be lost outright,
        // and the next open would paint the local snapshot with the edits and then
        // replace it with the server's, making them visibly appear and vanish.
        // Restore them into that record instead, so the next open replays them.
        // (beforeunload doesn't cover this — SPA navigation never fires it.)
        if (myKey !== DRAFT_KEY && snapAtFlush) {
          store.set(myKey, {
            snapshot: snapAtFlush,
            pending: ops,
            updatedAt: Date.now(),
          });
        }
        return;
      }
      pending = ops.concat(pending); // re-queue (incl. 409 contention) and retry shortly
      // mutate's 404 is permanent (token deleted/rotated mid-session), never
      // transient — stop retrying; the queue stays persisted on device. Unless THIS
      // device replaced the link while the batch was out (rotate): the old link it went
      // under is dead, the list isn't, and the same ops go again under the new one.
      if (statusOf(e) === 404) {
        persistLocal();
        if (editToken() === sentWith) setStatus("missing"); // else the finally sends them again
        return;
      }
      // offline surfaces honestly; a genuine server error keeps the "Not saved" cue
      setStatus(online.value ? "error" : "offline");
      persistLocal(); // keep the re-queued ops on device until they land
      failed = true;
      // BACK OFF, don't hammer. A server that just refused this batch is unlikely to
      // want it again in a second, and every open tab doing that turns a blip into
      // load at exactly the wrong moment. Doubles from 1.5s to a 30s ceiling; the
      // count resets the moment anything lands, so a one-off blip costs one wait.
      retryAfterBackoff(scheduleFlush);
    } finally {
      if (myEpoch === epoch) {
        inFlight = false;
        // ONLY chase the queue when this attempt actually landed. This is what drains
        // a >500-op backlog across sequential flushes (see the splice above) — but on
        // the failure path `pending` is never empty, because the catch just re-queued
        // the batch, so it fired every time and replaced the backoff above with its
        // own 450ms. That is what made a failing save retry ~1/second forever.
        if (!failed && pending.length) scheduleFlush();
      }
    }
  }

  // never adopt mid-drag (item OR folder): a reshuffle under the pointer would
  // commit the drop against pre-adoption geometry
  const dragging = () => useItemDnd().dragId.value != null || useFolderDnd().dragId.value != null;

  // ---- live-sync poll ----
  // The cadence follows the list's own activity. 3 s while it is live — an edit here
  // in the last two minutes, or a change that just arrived from elsewhere — because
  // that is when a collaborator's next change is worth showing within a breath. A tab
  // left open on a list nobody is touching stretches to 10 s after two quiet minutes
  // and 30 s after ten, and snaps back on any sign of life: a keystroke, a field taking
  // focus, the tab returning to view or the network coming back (both of which also
  // poll at once, so a change made while they were away shows immediately). Ten
  // times fewer requests for the common case, a solo editor reading their own list;
  // nothing changes for two people editing together, whose edits keep both sides
  // fast. A timeout chain rather than an interval, so the delay can move between
  // ticks.
  //
  // Two guards keep the chain honest. A tick carries the epoch it was SCHEDULED in,
  // so one queued by a list that has since been replaced exits on arrival rather
  // than adopting the new session (dispose, load, a new draft all bump the epoch).
  // And a wake that lands while a tick's request is in flight is noted rather than
  // started: a second concurrent request for the same version would race the first,
  // and the first's own rescheduling would otherwise cancel the immediate poll the
  // wake promised — so the in-flight tick honours it as it finishes.
  const POLL_FAST_MS = 3_000;
  const POLL_SLOW_MS = 10_000;
  const POLL_IDLE_MS = 30_000;
  let pollInFlight = false;
  let pollWakePending = false;
  function pollDelay(): number {
    const quiet = Date.now() - liveAt;
    return quiet < 2 * 60_000 ? POLL_FAST_MS : quiet < 10 * 60_000 ? POLL_SLOW_MS : POLL_IDLE_MS;
  }
  function schedulePoll(delay = pollDelay()) {
    clearTimeout(pollTimer);
    const scheduledEpoch = epoch;
    pollTimer = setTimeout(() => void pollTick(scheduledEpoch), delay);
  }
  /** Note a sign of life. `now` also polls straight away — the tab, or the network,
   *  just came back. */
  function wakePoll(now = false) {
    liveAt = Date.now();
    if (!polling || !now) return;
    if (pollInFlight) pollWakePending = true;
    else schedulePoll(0);
  }
  async function pollTick(myEpoch: number) {
    pollTimer = undefined;
    if (myEpoch !== epoch) return; // queued by a session that has since been replaced
    try {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!online.value) return; // nothing to pull while the connection is down
      if (inFlight || pending.length || !snapshot.value || dragging()) return;
      pollInFlight = true;
      const res = await $fetch<{ version: number; snapshot?: ListSnapshot }>(
        "/api/edit/changes",
        { headers: authHeaders(), query: { since: snapshot.value.version } },
      );
      if (myEpoch !== epoch) return;
      // adopt only a strictly-newer snapshot, and only when not mid-write/edit —
      // so a slow poll can't clobber a fresher flushed state with stale data
      if (
        res.snapshot &&
        snapshot.value &&
        res.snapshot.version > snapshot.value.version &&
        !isEditing &&
        !pending.length &&
        !inFlight &&
        !dragging()
      ) {
        reconcileSnapshot(snapshot.value, res.snapshot); // in place — see flush()
        syncRegistry();
        // mirror the adopted merge on device — the guards above guarantee the
        // queue is empty, so a hard tab kill can't leave a stale local copy
        persistLocal();
        wakePoll(); // someone else is here: stay quick for them
      }
    } catch {
      /* transient */
    } finally {
      pollInFlight = false;
      // the chain goes on only for the session that started it — a load() that
      // superseded this one mid-flight has a chain of its own
      if (polling && myEpoch === epoch) {
        const wake = pollWakePending;
        pollWakePending = false;
        schedulePoll(wake ? 0 : pollDelay());
      }
    }
  }
  function startPoll() {
    stopPoll();
    polling = true;
    liveAt = Date.now(); // a list just opened is live
    schedulePoll();
  }
  function stopPoll() {
    polling = false;
    pollWakePending = false;
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function installListeners() {
    if (typeof window === "undefined" || teardownListeners) return; // once only
    const onFocusIn = (e: FocusEvent) => { if (isFormField(e.target)) { isEditing = true; wakePoll(); } };
    const onFocusOut = () => { isEditing = false; };
    // back in view: poll now rather than wherever the idle cadence had got to
    const onVisibility = () => { if (!document.hidden) wakePoll(true); };
    // warn before leaving with unsynced edits — but offline edits are safely held
    // on device (IndexedDB), so only nag when a server sync is pending AND reachable.
    // A dead-token queue can never sync, so it never nags either.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if ((pending.length || inFlight) && online.value && !remoteMissing()) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focusout", onFocusOut);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    teardownListeners = () => {
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      teardownListeners = undefined;
    };
  }

  // ---- edits ----
  // Every mutator a component calls (folders, rows, days, pins, people, paste, nesting)
  // lives in useGearListEdits: they answer to the snapshot and the op queue and nothing
  // else, and were the longest stretch of this file that had nothing to do with syncing.
  // The few named here are the ones the engine itself calls.
  const edits = createEdits({ snapshot, dispatch, offerUndo, pendingBlankId });
  const { updateFolder, updateItem } = edits;

  /** Bank one row on demand — see useVault.captureOne for why it bypasses the
   *  debounce and the consent prompt that the automatic path is built around. */
  async function saveItemToVault(id: string): Promise<CaptureOneResult> {
    const snap = snapshot.value;
    const item = snap?.items.find((i) => i.id === id);
    if (!snap || !item) return "failed";
    const { result, landed } = await vault.captureOne(item, snap.items, snap.folders, editToken());
    // Folded in HERE rather than inside capture: the answer belongs to this list's
    // state, so a response that outlives the list (or the account) writes into a
    // Map that resetSession has already replaced, and nothing leaks anywhere.
    noteVaultGear(landed);
    return result;
  }

  /**
   * Offer this list's gear to the vault, if it's ours to offer.
   *
   * A draft (no token yet) is yours by definition. A list this device CREATED —
   * built, imported or cloned — recorded "yes" at that moment. Anything else is an
   * edit link you hold, which is either your own list on a second device or a
   * friend's, and the link cannot say which. So the first time gear would move, ask
   * once and remember; until it's answered, nothing is captured.
   */
  function captureIfMine() {
    if (!snapshot.value) return;
    // The decision lives in sync(), which asks only once it knows there is gear
    // worth asking about — see useVault.
    vault.sync(snapshot.value.items, snapshot.value.folders, {
      editToken: editToken(),
      // ...and what the vault already holds of it, so a list whose every row is
      // banked never raises a modal asking permission for a no-op. Passed in
      // rather than read from a singleton: this is the open list's answer, and
      // sync() has no business knowing where it came from.
      held: vaultGearAsked.value.size ? vaultGear.value : null,
      onAsk: () => {
        // an open chooser is this same question, further along
        if (!vaultPicker.value) vaultAsk.value = { step: "prompt", title: snapshot.value?.title || "this list" };
      },
    });
  }

  /**
   * Answer the prompt.
   *
   * "No" is final and needs nothing else. "Yes" opens the chooser rather than
   * taking the list wholesale: the only lists that ever ask are ones you didn't
   * start, and on a trip you planned together the tent is yours and the stove
   * isn't. All-or-nothing forces a wrong answer whichever way you go.
   */
  async function answerVaultPrompt(yes: boolean) {
    vaultAsk.value = null;
    if (!yes) {
      setVaultDecisionFor(editToken(), "no");
      return refreshVaultCover();
    }
    const s = snapshot.value;
    const myEpoch = epoch;
    const caps = s ? await vault.buildCaptures(s.items, s.folders) : [];
    if (myEpoch !== epoch) return; // the list changed under the question
    // nothing to choose between — record the answer and take the (empty) set, so
    // an empty chooser never appears and the question doesn't come back
    if (caps.length < 2) {
      setVaultDecisionFor(editToken(), "yes");
      refreshVaultCover();
      return captureIfMine();
    }
    vaultAsk.value = { step: "picker", rows: caps };
  }

  /** Confirm the chooser: `keep` is the normKeys ticked. Everything else is
   *  recorded as not-yours FOR THIS LIST, so later edits don't re-offer it. */
  function confirmVaultPicker(keep: string[]) {
    const offered = vaultPicker.value ?? [];
    vaultAsk.value = null;
    const kept = new Set(keep);
    setVaultExclusionsFor(
      editToken(),
      offered.filter((c) => !kept.has(c.normKey)).map((c) => c.normKey),
    );
    setVaultDecisionFor(editToken(), "yes");
    refreshVaultCover();
    captureIfMine();
  }

  /** Back out of the chooser. Deliberately records NOTHING: you opened it to
   *  decide and didn't, so the question is still open and the banner returns on
   *  the next edit. */
  function cancelVaultPicker() {
    vaultAsk.value = null;
  }


  async function rotate(): Promise<string | null> {
    // WHICH list is being rotated is read before the request, never after it. The
    // answer can land once the editor has moved on (the switcher, the back button and
    // /gear all stay usable while it's out), and reading editToken() then handed the
    // list now on screen the rotated list's token: its registry row and on-device
    // record were dropped and its edits flushed into the rotated list.
    const myEpoch = epoch;
    const old = editToken();
    const oldCode = claimCode();
    const oldKey = storeKey();
    const fromSnapshot = snapshot.value
      ? myLists.entryFromSnapshot({ editToken: old, snapshot: snapshot.value }, totals.value?.totalMg ?? 0)
      : null;
    let fresh: string;
    try {
      const res = await $fetch<{ editToken: string }>("/api/edit/rotate", {
        method: "POST",
        headers: authHeaders(),
      });
      fresh = res.editToken;
    } catch {
      return null;
    }
    // Still the session that asked? Only then does the screen change. Either way the
    // new token is kept below: the old one is dead server-side, so dropping the answer
    // would cost this device its only way back into the list.
    const ours = myEpoch === epoch;
    // A rotate hands THIS device the new link whichever way it was holding the
    // list — so a claimed open graduates to the token path here, and the editor
    // behaves from now on exactly as if the link had been opened directly.
    if (ours) access.value = { kind: "token", token: fresh };
    // The vault answer rides along. It's keyed by the token, but it answers a
    // question about the GEAR ("is this list's gear mine?"), and a rotate is the
    // owner cycling a leaked link on a list they've already answered for. Losing
    // the answer here meant the prompt re-asked and capture paused until it was
    // re-answered — for no new reason. The exclusions are half of that answer
    // ("only the tent is mine"), so they carry too. The old token's keys then
    // go: the token is dead server-side, and nothing else ever cleared these
    // (only deleteList does), so every rotate used to strand a pair for good.
    // A claimed open rotates with old = "" — vaultDecisionFor("") answers "yes"
    // (a claimed list is yours, the same rule capture follows), so the fresh
    // token inherits that and the ""-keyed clears below are no-ops.
    const decision = vaultDecisionFor(old);
    if (decision !== "ask") setVaultDecisionFor(fresh, decision);
    const declined = vaultExclusionsFor(old);
    if (declined.size) setVaultExclusionsFor(fresh, [...declined]);
    clearVaultDecisionFor(old);
    if (ours) refreshVaultCover(); // mirror the carried answer onto the rows
    // always persist the NEW token, even if the old registry entry was missing,
    // so a rotate can never strand the only copy of the write capability — built
    // from the snapshot as it stood when the rotate was asked for, by the same
    // mapping registerCreated uses
    const prev = old ? myLists.entries.value.find((e) => e.editToken === old) : undefined;
    const base = prev ?? fromSnapshot;
    // The on-device record moves to the new key. When this session is still open,
    // persistLocal writes it from the live snapshot; when it isn't, the stored copy
    // is carried across before the forget below deletes it.
    const carried = ours ? undefined : await store.get(oldKey);
    if (old) myLists.forget(old); // also drops the old token's on-device record
    // the claimed open's record re-keys onto the token; leaving the code-keyed
    // copy behind would resurface pre-rotate state on the next claimed open, and
    // its ledger entry would outlive the only route that reads it (the registry
    // row minted below is what the bare address resumes through from now on)
    if (oldCode) {
      store.del(claimedLocalKey(oldCode));
      forgetClaimedOpen(oldCode);
    }
    if (base) myLists.upsert({ ...base, editToken: fresh, lastOpened: Date.now() });
    if (ours) persistLocal(); // re-key this device's copy onto the new token
    else if (carried) store.set(localKey(fresh), carried);
    // null when the editor has moved on: the caller's address-bar write and its
    // "replaced" toast both belong to a screen that's gone
    return ours ? fresh : null;
  }

  function dispose(ownEpoch?: number) {
    // Ownership check: on an /e ↔ /e/[code] route-record swap, Nuxt runs the NEW
    // page's setup (whose hash watcher starts a fresh load/startDraft, bumping
    // epoch) BEFORE the old page unmounts — so the old instance's unmount dispose
    // arrives late and must not tear down the session the newer instance just
    // started (it would abandon the in-flight load and strand "Loading…").
    // Callers pass the epoch of the session THEY started; if the controller has
    // moved on, this dispose isn't theirs to run. An undefined ownEpoch disposes
    // unconditionally (a new instance clearing whatever came before it).
    if (ownEpoch !== undefined && ownEpoch !== epoch) return;
    // best-effort: flush unsynced edits before teardown (SPA nav / unmount) so
    // queued ops aren't silently dropped on the way out. Capped at the server's
    // 500-op batch limit (it rejects oversized batches); the remainder is safe in
    // the on-device copy below and drains on the next open. A dead token would only
    // 404, so don't bother.
    if (pending.length && holdsList() && !remoteMissing()) {
      $fetch("/api/edit/mutate", { method: "POST", headers: authHeaders(), body: { ops: pending.slice(0, 500) } }).catch(() => {});
    }
    // capture the latest state on device before teardown — the debounced persist
    // may not have fired, and SPA nav / unmount must not drop the last edits
    writeLocal();
    clearTimeout(persistTimer);
    bumpEpoch(); // invalidate any in-flight flush/poll responses
    // drop any in-flight drag (item or folder) so it can't commit against a new list
    useItemDnd().reset();
    useFolderDnd().reset();
    stopPoll();
    undo.clear();
    teardownListeners?.();
    snapshot.value = null;
    access.value = { kind: "none" };
    resetSession();
    status.value = "idle";
  }

  return {
    snapshot, totals, status,
    get editToken() { return editToken(); },
    get claimCode() { return claimCode(); },
    get epoch() { return epoch; },
    epochRef,
    openedByCode,
    keylessCode,
    startKeyless,
    authHeaders,
    load, retryLoad, startDraft, dispose, rotate,
    vaultPrompt, answerVaultPrompt,
    vaultPicker, confirmVaultPicker, cancelVaultPicker,
    vaultAuto, vaultDeclined,
    // what My Gear holds of this list's gear, and which keys have an answer at
    // all — ItemRow renders its save button against the pair (see askVaultGear);
    // and which of them it holds as kits, for a group row's button
    vaultGear, vaultKits, vaultGearAsked, vaultGearSettled,
    // every mutator: folders, rows, days, pins, people, paste, nesting (useGearListEdits)
    ...edits,
    saveItemToVault,
    pendingBlankId, offerUndoAdd,
    pendingUndo: undo.pending, undoRemove: undo.take, holdUndo: undo.hold, releaseUndo: undo.release,
  };
}

export function useGearList() {
  if (!singleton) singleton = create();
  return singleton;
}

/** The longest the editor page holds the list you're leaving for the on-device copy of
 *  the one you're opening. Once IndexedDB is open the read takes a few ms; this only
 *  bounds a slow open, past which the list opens the old way, through "Loading…". */
const READ_AHEAD_MS = 250;

/**
 * Read the on-device copy of the list `route` opens BEFORE the editor mounts, for
 * load() to take without waiting (useLocalListStore's held read).
 *
 * Switching lists remounts the page, and the new editor's load used to await this
 * read with nothing to draw: for those frames the topbar lost every control but the
 * switcher and the page said "Loading…", then the list flashed back in. On a phone
 * that was several frames. The editor pages await this in setup instead, so the
 * page's Suspense keeps the outgoing list on screen through the read (the controller
 * is untouched until the new editor starts its session), and the new editor's first
 * frame is the list it opened.
 *
 * Mirrors the editor's route watcher: the fragment's token wins, and a bare code is a
 * claimed open only on the session hint. A list not on this device reads as nothing
 * and opens from the network as it always has.
 */
export function readAhead(route: { hash: string; params: Record<string, unknown> }): Promise<void> {
  let token: string;
  try {
    token = decodeURIComponent(route.hash.replace(/^#/, ""));
  } catch {
    return Promise.resolve(); // a malformed fragment: the watcher throws on it too
  }
  const param = route.params.code;
  const code = normalizeShareCode(typeof param === "string" ? param : "");
  const key = token ? localKey(token) : code && useSession().hasSessionHint() ? claimedLocalKey(code) : "";
  if (!key) return Promise.resolve();
  return Promise.race([
    useLocalListStore().prefetch(key),
    new Promise<void>((resolve) => setTimeout(resolve, READ_AHEAD_MS)),
  ]);
}
