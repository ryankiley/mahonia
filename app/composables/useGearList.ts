import type { DayPatch, ItemPatch, Op } from "~~/shared/ops";
import { applyOps, seedRouteEnds, tidyListText } from "~~/shared/ops";
import { uid } from "~~/shared/id";
import { colorKeyForName, nextFolderColor, STARTER_FOLDERS } from "~~/shared/categories";
import { LIST_CODE_HEADER, editLinkPath, normalizeShareCode } from "~~/shared/links";
import { DRAFT_KEY, claimedLocalKey, hasRealContent, localKey, rebaseOnto } from "~~/shared/localList";
import { sortedPeople } from "~~/shared/people";
import { reconcileSnapshot } from "~~/shared/reconcile";
import type { Folder, Item, ListSnapshot, Person, Unit, Waypoint, WaypointKind } from "~~/shared/types";
import { pickListMeta } from "~~/shared/types";
import type { VaultCapture, VaultEntry } from "~~/shared/vault";
import { vaultNormKey } from "~~/shared/vault";
import { bySortOrder, computeTotals, entryUnitFromInput, nextSortOrder, parseWeightInput, siblingItems } from "~~/shared/weights";
import { createNesting } from "~/composables/useGearListNesting";

// Editor controller (one list open at a time → module singleton). Mutations are
// applied optimistically via the SAME op-reducer the server uses, queued, and
// flushed (debounced). A poll pulls other editors' merged changes live. The queue
// is mirrored to IndexedDB (useLocalListStore) so a draft or an un-acked edit
// survives a reload, a crash, or a dropped connection.

type Status = "idle" | "loading" | "saving" | "synced" | "missing" | "error" | "offline";

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const snapshot = ref<ListSnapshot | null>(null);
  const status = ref<Status>("idle");
  // a freshly "Add an item" row that's still empty — it autofocuses on mount and
  // discards itself if you click away without typing (so the list isn't littered)
  const pendingBlankId = ref<string | null>(null);
  let editToken = "";
  // The OTHER way into a list: the share code of a CLAIMED one, opened through the
  // signed-in session instead of an edit link (see server/utils/editAuth). Never
  // set while editToken is — the token is the stronger claim and always wins.
  let claimCode = "";
  // Reactive mirror of "this open holds no token" for the template layer — the
  // plain getters below can't be tracked, and the chrome needs to hide the
  // token-only affordances (Forget, the copyable edit link) on a claimed open.
  const openedByCode = ref(false);
  let pending: Op[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  // The failure path's own timer, kept apart from flushTimer so a backoff already
  // counting down can be cancelled on teardown rather than firing into a session that
  // has moved on. Its delay grows with flushFailures, which any successful flush zeroes.
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let flushFailures = 0;
  let inFlight = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let isEditing = false;
  // The server has no row under this token (deleted, or the link was rotated) but
  // a local copy is still on screen. Mutate's 404 is a permanent token-lookup
  // failure, so while set, edits persist to IndexedDB only — never queued/flushed
  // against the dead token.
  let remoteMissing = false;
  // bumped on every load/dispose so in-flight responses for a previous list are ignored
  let epoch = 0;
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
  const vaultPrompt = ref<{ title: string } | null>(null);
  // the rows the chooser is offering, or null when it's closed
  const vaultPicker = ref<VaultCapture[] | null>(null);
  // Whether the AUTOMATIC capture path is on for this list (the stored answer is
  // "yes"), and which rows the chooser declined. The stored truth lives in
  // localStorage, which nothing can react to — so it's mirrored into refs here,
  // re-read by refreshVaultCover() at every point the answer (or the token it's
  // keyed by) changes. ItemRow renders against these: a row the automatic path
  // already banks shows its save button as already banked rather than offering
  // to do what's done.
  const vaultAuto = ref(false);
  const vaultDeclined = ref<ReadonlySet<string>>(new Set());
  function refreshVaultCover() {
    vaultAuto.value = vaultDecisionFor(editToken) === "yes";
    vaultDeclined.value = vaultExclusionsFor(editToken);
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
  // The vault's READ side: which gear it already holds, so a row can stop
  // offering to save what's saved (useVaultKeys). Resolved here, with the rest of
  // the controller's collaborators, rather than inside load() — that runs from an
  // async callback, and the session state underneath is a useState.
  const vaultKeys = useVaultKeys();
  scope.run(() => vault.bindFlushOnLeave());
  const online = scope.run(() => useOnline())!;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  // The IndexedDB slot this open persists under: the edit token, a code-prefixed
  // key for a claimed open, or the draft slot before first save.
  const storeKey = () => (claimCode ? claimedLocalKey(claimCode) : localKey(editToken));

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
        if (snapshot.value && status.value !== "loading") status.value = "offline";
        return;
      }
      if (!snapshot.value) return;
      if (!editToken && !claimCode) {
        if (hasRealContent(snapshot.value)) createFromDraft();
      } else if (remoteMissing) {
        status.value = "missing"; // still dead server-side; nothing to drain
      } else if (pending.length) {
        scheduleFlush();
      } else if (status.value === "offline") {
        status.value = "synced";
      }
    });
  });

  // single-level undo for destructive removes — drives the "Undo" toast
  // 10s: the full notice → reach → tap loop has to fit, including on mobile
  const UNDO_MS = 10_000;
  const pendingUndo = ref<{ label: string; restore: () => void } | null>(null);
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  function offerUndo(label: string, restore: () => void) {
    pendingUndo.value = { label, restore };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => (pendingUndo.value = null), UNDO_MS);
  }
  // The toast pauses its dismiss timer while pointed at or holding focus — someone
  // reading it (or reaching for the button) shouldn't race the clock. Release
  // restarts the FULL window, not the remainder: it's cheap and never surprises.
  function holdUndo() {
    clearTimeout(undoTimer);
  }
  function releaseUndo() {
    if (!pendingUndo.value) return;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => (pendingUndo.value = null), UNDO_MS);
  }
  function undoRemove() {
    const u = pendingUndo.value;
    if (!u) return;
    u.restore();
    pendingUndo.value = null;
    clearTimeout(undoTimer);
  }

  const totals = computed(() =>
    snapshot.value ? computeTotals(snapshot.value) : null,
  );

  // The write capability, as request headers. Two shapes, matching the server's
  // one gate (editAuth): the bearer token when this device holds the edit link,
  // else the claimed list's code — the session cookie rides along on its own and
  // is the part that actually proves anything.
  function authHeaders() {
    if (editToken) return { Authorization: `Bearer ${editToken}` } as Record<string, string>;
    return { [LIST_CODE_HEADER]: claimCode } as Record<string, string>;
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
    if (editToken) useMyLists().touch(editToken, patch);
    // a claimed open has no registry row — its switcher row reads the account
    // list, so a rename here has to reach THAT copy to show up in the dropdown
    else if (claimCode) useClaimedLists().touchByCode(claimCode, patch);
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
    const row = editToken
      ? useMyLists().entries.value.find((e) => e.editToken === editToken)
      : claimCode
        ? useClaimedLists().lists.value.find((l) => l.shareCode === claimCode)
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
    if (!snapshot.value || !editToken) return;
    // registerCreated owns the snapshot→MyListEntry mapping — one source of truth.
    // Marked "opened", because this is the path where a list arrives via a link
    // someone SENT you: signing in must not quietly attach it to your account.
    // upsert keeps a prior "created" if you made this list yourself and are merely
    // reopening it, so your own lists aren't downgraded by coming back to them.
    useMyLists().registerCreated(
      { editToken, snapshot: snapshot.value },
      totals.value?.totalMg ?? 0,
      "opened",
    );
  }

  // Everything one list's session owns, zeroed. Every way a session begins or ends
  // — load(), startDraft(), dispose() — runs this AFTER the capability (editToken /
  // claimCode) is set for the new session, so a queue, an in-flight flag or a
  // backoff from the last list can never leak into the next one.
  function resetSession() {
    pending = [];
    inFlight = false;
    isEditing = false;
    remoteMissing = false;
    // the vault question is about THIS list — an unanswered one must not ride
    // along to the next list opened (where it would ask about the wrong gear,
    // and spend that list's one chance to ask). A draft is yours, and never asks.
    vaultPrompt.value = null;
    // ...and the rows must render against THIS list's answer (a draft's answer IS
    // yes: no token → yours by definition)
    refreshVaultCover();
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
    epoch++;
    const myEpoch = epoch;
    editToken = cap.token ?? "";
    // normalized so a hand-typed /e/{code} URL and the canonical code the server
    // returns key the same IndexedDB record and claimed-lists row
    claimCode = editToken ? "" : normalizeShareCode(cap.code);
    openedByCode.value = !editToken && !!claimCode;
    resetSession();
    // Re-read what My Gear holds, but only when it could change what a row draws.
    //
    // /gear can have edited the vault since the last read (a row added by hand,
    // one removed), and neither reaches this cache on its own. But a row consults
    // membership at all only when the automatic path ISN'T already claiming it —
    // so on a list this device built (answer "yes", nothing declined) and on every
    // claimed open, the read provably cannot move a pixel, and refreshVaultCover()
    // one line above has just made both answers current. Skipping those is worth
    // real money: each read is a session lookup, a `vaults` row write (the
    // last-seen bump in resolveVaultForRead) and the query.
    //
    // Best-effort to the point of silence — it decides whether a save button
    // shows, and a list must never wait on it or fail because of it.
    if (!vaultAuto.value || vaultDeclined.value.size) void vaultKeys.refreshVaultKeys();
    snapshot.value = null;
    status.value = "loading";
    installListeners();

    // Hydrate from this browser's local copy first — instant paint, and the only
    // thing we can show if the network is down. Restore its un-acked queue too.
    const local = await store.get(storeKey());
    if (myEpoch !== epoch) return; // a newer load() superseded this one
    if (local) {
      // Backfilled on the way in, matching what the server does on the way out
      // (rowToSnapshot). This copy is the FIRST paint and, offline, the only one — an
      // old list cached before the tidy existed would otherwise show straight
      // apostrophes until the network answered, then visibly re-spell itself.
      snapshot.value = tidyListText(local.snapshot);
      pending = local.pending ?? [];
      status.value = pending.length ? "saving" : "synced";
      syncRegistry();
    }

    try {
      const res = await $fetch<{ snapshot: ListSnapshot }>("/api/edit/list", {
        headers: authHeaders(),
      });
      if (myEpoch !== epoch) return;
      // server is authoritative; replay any un-acked local ops on top of it
      const merged = rebaseOnto(res.snapshot, pending);
      snapshot.value = merged;
      status.value = pending.length ? "saving" : "synced";
      registerOpened(); // server confirmed the token → remember this list in "Your lists"
      // NO capture on open. It used to happen here, to catch a list that arrived
      // whole (imported, cloned) and dispatches no ops — but an edit link is an
      // edit link, and this hook could not tell YOUR list opened on a second device
      // from one a friend shared with you. So opening a shared list copied its
      // owner's gear into the opener's vault, and minted a vault for someone who
      // had never asked for one. The whole-list cases capture at the moment they're
      // CREATED instead (useVaultCapture().captureNewList), where the device knows
      // it made the thing; everything else still captures as you edit.
      hydrating = true;
      // one-time cleanup: early water rows were named "Water · 1 L"; the volume now
      // lives in the qty (litres) field, so the name should just be "Water"
      for (const it of merged.items) {
        if (/^water\s*·/i.test(it.name)) updateItem(it.id, { name: "Water" });
      }
      // one-time backfill: lists imported before folders got colours assigned have
      // every folder on the neutral grey ("other"), so the category chart reads as
      // all grey. Reassign distinct palette hues — same logic as addFolder — so the
      // viz is colourful. "other" is never auto-assigned and has no picker, so the
      // only folders carrying it came from a pre-colour import; recolouring is safe
      // and self-persists via the mutate flow (covers existing prod lists on open).
      const colorKeys = merged.folders.map((f) => f.colorKey ?? "other");
      merged.folders.forEach((f, i) => {
        if (colorKeys[i] !== "other") return;
        const colorKey = nextFolderColor(colorKeys);
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
      for (const it of merged.items) {
        if (it.parentId == null) continue;
        const parent = merged.items.find((p) => p.id === it.parentId);
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
        editToken &&
        merged.shareCode
      ) {
        history.replaceState(history.state, "", editLinkPath(merged.shareCode, editToken));
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
      if (e?.statusCode === 404 || (e?.statusCode === 401 && claimCode)) {
        // If we still hold a local copy, keep it on screen so the data is
        // readable/exportable, but don't poll or flush against a dead capability —
        // and don't claim "synced": later edits stay device-only (remoteMissing).
        remoteMissing = true;
        status.value = "missing";
        // A dead token whose list ALSO has a live row in the registry is the
        // leftover half of a rotate — the switcher was showing that pack twice,
        // both rows marked current, and this is the one that no longer opens.
        // Only the row goes; the local copy on screen is untouched (see the
        // composable). The live-side heal is upsert's share-code claim, so it
        // takes one visit to either row, whichever you happened to pick.
        if (editToken) useMyLists().forgetSuperseded(editToken);
      } else if (local) {
        // Network failure with a local copy: keep editing, sync when it returns.
        status.value = "offline";
        if (pending.length) scheduleFlush();
        startPoll();
      } else {
        status.value = "error";
      }
    }
  }

  // "Has content" — the gate on persisting a draft at all — is hasRealContent in
  // shared/localList, shared with the sync line so both read the same rule.

  // Open a fresh, NOT-yet-persisted list (starter folders, no items). It lives only
  // in memory until the first real content lands (createFromDraft), so a visitor who
  // never adds anything never creates a server row.
  function startDraft() {
    epoch++;
    const myEpoch = epoch;
    editToken = "";
    claimCode = "";
    openedByCode.value = false;
    resetSession();
    installListeners();
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
      isPublic: false,
    };
    status.value = "synced";
    // Restore an in-progress, never-saved draft if one survived a reload/crash.
    // Async (IndexedDB), so the fresh starter paints first and is replaced if found.
    store.get(DRAFT_KEY).then((local) => {
      if (myEpoch !== epoch || editToken || !local) return;
      snapshot.value = tidyListText(local.snapshot); // same backfill as the token path
      pending = local.pending ?? [];
      status.value = "synced";
      // a restored draft that already has real content resumes its create attempt
      if (hasRealContent(local.snapshot)) createFromDraft();
    });
  }

  // Persist a draft to the server on its first real content. The created snapshot
  // keeps the client-side folder/item ids (the create path normalizes but preserves
  // ids), so adopting it doesn't disturb focus or references. Ops typed during the
  // round-trip are queued and flushed right after.
  async function createFromDraft() {
    // claimCode too: a claimed open is a SAVED list — letting it fall through
    // here would mint a duplicate of it under a fresh token
    if (inFlight || editToken || claimCode || !snapshot.value) return;
    // offline: the draft is already persisted locally; create once back online
    if (!online.value) { status.value = "offline"; return; }
    const myEpoch = epoch;
    inFlight = true;
    status.value = "saving";
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
      if (myEpoch !== epoch) return;
      editToken = res.editToken;
      const merged = res.snapshot;
      if (pending.length) applyOps(merged, pending); // edits made mid-create
      snapshot.value = merged;
      status.value = "synced";
      // the draft is now a real list — move its on-device record onto the token key
      store.del(DRAFT_KEY);
      persistLocal();
      // register the write capability + put the token in the URL WITHOUT routing
      // (replaceState, so the editor's hash watcher doesn't dispose/reload us)
      const token = useMyLists().registerCreated(res, totals.value?.totalMg ?? 0);
      setVaultDecisionFor(token, "yes"); // you built it; it's yours without asking
      refreshVaultCover(); // the answer moved onto the new token; keep the mirror true
      // pretty path (/e/{shareCode}#{token}) so the URL is share-ready immediately;
      // replaceState (not routing) so the hash watcher doesn't dispose/reload us
      if (typeof history !== "undefined")
        history.replaceState(history.state, "", editLinkPath(res.snapshot.shareCode, token));
      startPoll();
    } catch {
      if (myEpoch !== epoch) return;
      status.value = "error";
      // retry while there's still un-persisted content
      setTimeout(() => {
        if (!editToken && snapshot.value && hasRealContent(snapshot.value)) createFromDraft();
      }, 1500);
    } finally {
      if (myEpoch === epoch) {
        inFlight = false;
        if (editToken && pending.length) scheduleFlush();
      }
    }
  }

  function dispatch(op: Op) {
    if (!snapshot.value) return;
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
    // Draft (no capability yet): keep edits local until there's real content, then
    // create the list once. While that create is in flight, queue ops for the
    // post-create flush. A claimed open is NOT a draft — it queues and flushes
    // below exactly like a token-held list.
    if (!editToken && !claimCode) {
      if (inFlight) pending.push(op);
      else if (hasRealContent(snapshot.value)) createFromDraft();
      return;
    }
    // the server row is gone (deleted/rotated token) — edits stay on-device only
    if (remoteMissing) return;
    pending.push(op);
    scheduleFlush();
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 450);
  }

  async function flush() {
    if (inFlight || remoteMissing || !pending.length || !snapshot.value) return;
    // offline: leave the queue intact + persisted; the online watcher re-flushes
    if (!online.value) { status.value = "offline"; persistLocal(); return; }
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
    if (status.value !== "error") status.value = "saving";
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
      status.value = "synced";
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
      // transient — stop retrying; the queue stays persisted on device
      if (e?.statusCode === 404) {
        remoteMissing = true;
        status.value = "missing";
        persistLocal();
        return;
      }
      // offline surfaces honestly; a genuine server error keeps the "Not saved" cue
      status.value = online.value ? "error" : "offline";
      persistLocal(); // keep the re-queued ops on device until they land
      failed = true;
      // BACK OFF, don't hammer. A server that just refused this batch is unlikely to
      // want it again in a second, and every open tab doing that turns a blip into
      // load at exactly the wrong moment. Doubles from 1.5s to a 30s ceiling; the
      // count resets the moment anything lands, so a one-off blip costs one wait.
      flushFailures++;
      const backoff = Math.min(1500 * 2 ** (flushFailures - 1), 30_000);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(scheduleFlush, backoff);
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

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!online.value) return; // nothing to pull while the connection is down
      if (inFlight || pending.length || !snapshot.value || dragging()) return;
      const myEpoch = epoch;
      try {
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
        }
      } catch {
        /* transient */
      }
    }, 3000);
  }
  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function installListeners() {
    if (typeof window === "undefined" || teardownListeners) return; // once only
    const isField = (el: EventTarget | null) =>
      el instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    const onFocusIn = (e: FocusEvent) => { if (isField(e.target)) isEditing = true; };
    const onFocusOut = () => { isEditing = false; };
    // warn before leaving with unsynced edits — but offline edits are safely held
    // on device (IndexedDB), so only nag when a server sync is pending AND reachable.
    // A dead-token queue (remoteMissing) can never sync, so it never nags either.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if ((pending.length || inFlight) && online.value && !remoteMissing) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focusout", onFocusOut);
    window.addEventListener("beforeunload", onBeforeUnload);
    teardownListeners = () => {
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("beforeunload", onBeforeUnload);
      teardownListeners = undefined;
    };
  }

  // ---- convenience mutators ----
  // The patch type is READ OFF the op rather than restated here. It was a hand-copied
  // duplicate of the same field list, so adding a meta field to the reducer left this
  // wrapper rejecting it — which is exactly what happened when trip dates landed.
  const setMeta = (patch: Extract<Op, { t: "setMeta" }>["patch"]) =>
    dispatch({ t: "setMeta", patch });
  const setUnit = (displayUnit: Unit) => setMeta({ displayUnit });

  /**
   * Clone a whole vault folder into the list — a category template.
   *
   * The vault already files gear by the NAME of the list folder it came from, so a
   * "Cook kit" you built once is already a set; this is the missing direction, which
   * is getting the set back out. Reuses addFolder + addVaultItem rather than building
   * items here, so the naming/colour rules and the pinned-override rules each stay in
   * one place.
   *
   * Gear the list already holds is skipped, matching the pane's per-row rule: wanting
   * two of something is a quantity, and a second identical row would split one thing's
   * weight across two lines.
   *
   * Returns the new folder's id, or "" if there was nothing to add — the caller
   * shouldn't be left with an empty folder it didn't ask for.
   */
  function addVaultFolder(name: string, entries: VaultEntry[]): string {
    if (!snapshot.value || !entries.length) return "";
    const held = new Set(
      snapshot.value.items
        .map((i) => vaultNormKey(i.brand, i.name, i.variant))
        .filter(Boolean),
    );
    const fresh = entries.filter((e) => !held.has(e.normKey));
    if (!fresh.length) return "";

    const folders = snapshot.value.folders;
    const id = uid();
    dispatch({
      t: "addFolder",
      folder: {
        id,
        name,
        colorKey: colorKeyForName(name, folders.map((f) => f.colorKey ?? "other")),
        defaultClassification: "base",
        sortOrder: folders.length,
      },
    });
    for (const entry of fresh) addVaultItem(entry, id);
    return id;
  }

  function addFolder(name = "New folder") {
    const folders = snapshot.value?.folders ?? [];
    // a recognised name (e.g. "Clothing") gets its canonical hue; otherwise the
    // next distinct palette colour (see colorKeyForName)
    const colorKey = colorKeyForName(name, folders.map((f) => f.colorKey ?? "other"));
    dispatch({ t: "addFolder", folder: { id: uid(), name, colorKey, defaultClassification: "base", sortOrder: folders.length } });
  }
  const updateFolder = (id: string, patch: Partial<Folder>) =>
    dispatch({ t: "updateFolder", id, patch });
  // drag-reorder: move folder `id` to just before/after `targetId`, then reindex
  function moveFolderBefore(id: string, targetId: string, before: boolean) {
    if (!snapshot.value || id === targetId) return;
    const folders = [...snapshot.value.folders].sort(bySortOrder);
    const moving = folders.find((f) => f.id === id);
    if (!moving) return;
    const without = folders.filter((f) => f.id !== id);
    const ti = without.findIndex((f) => f.id === targetId);
    if (ti < 0) return;
    without.splice(before ? ti : ti + 1, 0, moving);
    renumber(without, (id, sortOrder) => updateFolder(id, { sortOrder }));
  }
  // Make `rows` (already in display order) gapless: one patch per row whose sortOrder
  // isn't its position. Folders after a drag, days and people after a removal all
  // need it, so the numbering a person reads ("Day 3", the chip order) stays the
  // position in the list rather than drifting from it.
  function renumber(
    rows: readonly { id: string; sortOrder: number }[],
    update: (id: string, sortOrder: number) => void,
  ) {
    rows.forEach((r, i) => {
      if (r.sortOrder !== i) update(r.id, i);
    });
  }
  // ---- trip days ----
  // Thin, unlike the folder helpers above: a day has no colour to allocate, no items to
  // carry with it, and nothing pointing at it, so there is no cascade to write and no
  // undo to offer — a removed day is two numbers, and re-typing them costs less than the
  // toast would. Reordering is a sortOrder patch, exactly as it is for folders.
  function addDay() {
    const days = snapshot.value?.days ?? [];
    dispatch({ t: "addDay", day: { id: uid(), sortOrder: days.length } });
  }
  const updateDay = (id: string, patch: DayPatch) => dispatch({ t: "updateDay", id, patch });
  /** A pin at a distance along the route. No sortOrder — route order is the only order. */
  function addWaypoint(alongM: number, kind: WaypointKind = "landmark") {
    dispatch({ t: "addWaypoint", waypoint: { id: uid(), kind, alongM } });
  }
  /**
   * The route's two ends, for a list whose geometry predates them.
   *
   * seedRouteEnds fires when the geometry CHANGES (see the reducer's setMeta), so a route
   * imported before this existed has no trailhead and no finish — and no way to grow one,
   * because neither kind is placeable by hand, on purpose. This fills the gap from the
   * geometry the list is already holding, reusing the seeder's own fixed ids so a second
   * call adds nothing and a loop stays a loop.
   *
   * NOT in the reducer. A reducer replays ops and has to give the same answer every time;
   * a rule that invents a waypoint whenever it notices one missing would write a different
   * history depending on when it happened to run.
   */
  function ensureRouteEnds() {
    const geo = snapshot.value?.routeGeometry;
    if (!geo) return;
    const have = new Set((snapshot.value?.waypoints ?? []).map((w) => w.id));
    for (const w of seedRouteEnds(geo)) {
      if (!have.has(w.id)) dispatch({ t: "addWaypoint", waypoint: w });
    }
  }
  const updateWaypoint = (id: string, patch: Partial<Waypoint>) =>
    dispatch({ t: "updateWaypoint", id, patch });
  // No renumbering afterwards, unlike removeDay: nothing about a waypoint's identity comes
  // from its position in the array, so removing one leaves the rest exactly as they were.
  const removeWaypoint = (id: string) => dispatch({ t: "removeWaypoint", id });
  function removeDay(id: string) {
    dispatch({ t: "removeDay", id });
    // close the gap so "Day 3" stays the third day — see renumber
    renumber((snapshot.value?.days ?? []).slice().sort(bySortOrder), (id, sortOrder) =>
      updateDay(id, { sortOrder }),
    );
  }

  // ---- people ----
  // Thin like the day helpers: nothing to cascade client-side (the reducer's
  // removePerson clears assignments itself, on both ends of the wire), and no undo
  // toast — a removed person is one name, and their items stay put, just unclaimed.
  function addPerson(name: string): string {
    const people = sortedPeople(snapshot.value?.people);
    const id = uid();
    dispatch({
      t: "addPerson",
      person: {
        id,
        name,
        // the folder palette walk, seeded with the FOLDERS' hues as well as the
        // people's: person dots and folder dots are the same swatch two rows apart
        // (CategoryBar above, chips below), so a person taking the Shelter
        // folder's green would put one color on two meanings. Distinct across both.
        colorKey: nextFolderColor([
          ...(snapshot.value?.folders ?? []).map((f) => f.colorKey ?? "other"),
          ...people.map((p) => p.colorKey ?? "other"),
        ]),
        sortOrder: people.length,
      },
    });
    return id;
  }
  const updatePerson = (id: string, patch: Partial<Person>) =>
    dispatch({ t: "updatePerson", id, patch });
  function removePerson(id: string) {
    dispatch({ t: "removePerson", id });
    // renumber like removeDay, so the chip order a person reads stays gapless.
    // NOT the place that widens a filter aimed at whoever just left — GearEditor's
    // watcher owns that, and covers a COLLABORATOR's removal arriving by poll too.
    renumber(sortedPeople(snapshot.value?.people), (id, sortOrder) => updatePerson(id, { sortOrder }));
  }

  function removeFolder(id: string) {
    const folder = snapshot.value?.folders.find((f) => f.id === id);
    // parents before children so nesting re-links on undo (addItem drops a child whose
    // parent isn't back yet). Nested children are included — they carry their
    // parent's folderId — which is exactly what the undo needs to restore.
    const items = (snapshot.value?.items ?? [])
      .filter((i) => i.folderId === id)
      .map((i) => ({ ...i }))
      .sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
    dispatch({ t: "removeFolder", id });
    if (folder) {
      const f = { ...folder };
      offerUndo(folder.name || "Folder", () => {
        dispatch({ t: "addFolder", folder: f });
        for (const it of items) dispatch({ t: "addItem", item: it });
      });
    }
  }

  // "Add an item" drops a real, empty row in immediately (so it has every control
  // a normal row has) and focuses it; discardEmpty cleans it up if abandoned.
  function addBlankItem(folderId: string | null): string {
    if (!snapshot.value) return "";
    const id = uid();
    const sortOrder = nextSortOrder(snapshot.value.items, folderId);
    const item: Item = { id, folderId, name: "", unitWeightMg: 0, qty: 1, classification: null, sortOrder };
    // Under an active person filter the new row is pre-claimed for that person —
    // otherwise it would materialize already hidden by the very filter the user is
    // typing inside. Deliberately not part of discardEmpty's "has content" test:
    // an abandoned blank still tidies itself away, stamp and all.
    const personId = usePersonFilter().assignTarget(snapshot.value.people);
    if (personId) item.personId = personId;
    dispatch({ t: "addItem", item });
    pendingBlankId.value = id;
    return id;
  }
  // Add a piece of gear straight from the vault — the VaultPane's one write.
  //
  // A complete row lands in one dispatch, NOT a blank row that is then patched: a
  // half-built row that briefly exists would trip the pending-blank focus machinery
  // and the discard-on-blur cleanup.
  //
  // The value semantics mirror an autocomplete pick from the vault (see ItemRow's
  // onNameCommit): the weight and the name are the HOLDER'S, so they're marked
  // overridden and the catalog's live-resolve leaves them alone. The catalog link
  // rides along when the gear originally came from a pick, so nothing else that
  // keys off it breaks.
  function addVaultItem(entry: VaultEntry, folderId: string | null): string {
    if (!snapshot.value) return "";
    const id = uid();
    const item: Item = {
      id,
      folderId,
      name: entry.name,
      brand: entry.brand,
      variant: entry.variant,
      commonName: entry.commonName,
      // the vault's label is the holder's own, so pin it against live-resolve
      commonNameOverridden: entry.commonName ? true : undefined,
      nameOverridden: true,
      unitWeightMg: entry.weightMg,
      weightOverridden: true,
      qty: 1,
      // "base" is stored as null — it IS the folder default, and storing it
      // explicitly would pin the row against a later change to that default
      classification: entry.classification && entry.classification !== "base" ? entry.classification : null,
      // the calories the vault remembers for this food, like the weight above
      kcal: entry.kcal,
      catalogItemId: entry.catalogItemId,
      // same pre-claim as addBlankItem: gear pulled from the vault while narrowed
      // to one person lands in that person's view, not invisibly outside it
      personId: usePersonFilter().assignTarget(snapshot.value.people),
      sortOrder: nextSortOrder(snapshot.value.items, folderId),
    };
    dispatch({ t: "addItem", item });
    return id;
  }
  /** Bank one row on demand — see useVault.captureOne for why it bypasses the
   *  debounce and the consent prompt that the automatic path is built around. */
  async function saveItemToVault(
    id: string,
  ): Promise<"saved" | "unworthy" | "removed" | "full" | "failed"> {
    const snap = snapshot.value;
    const item = snap?.items.find((i) => i.id === id);
    if (!snap || !item) return "failed";
    return vault.captureOne(item, snap.items, snap.folders, editToken);
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
      editToken,
      onAsk: () => (vaultPrompt.value = { title: snapshot.value?.title || "this list" }),
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
    vaultPrompt.value = null;
    if (!yes) {
      setVaultDecisionFor(editToken, "no");
      return refreshVaultCover();
    }
    const s = snapshot.value;
    const caps = s ? await vault.buildCaptures(s.items, s.folders) : [];
    // nothing to choose between — record the answer and take the (empty) set, so
    // an empty chooser never appears and the question doesn't come back
    if (caps.length < 2) {
      setVaultDecisionFor(editToken, "yes");
      refreshVaultCover();
      return captureIfMine();
    }
    vaultPicker.value = caps;
  }

  /** Confirm the chooser: `keep` is the normKeys ticked. Everything else is
   *  recorded as not-yours FOR THIS LIST, so later edits don't re-offer it. */
  function confirmVaultPicker(keep: string[]) {
    const offered = vaultPicker.value ?? [];
    vaultPicker.value = null;
    const kept = new Set(keep);
    setVaultExclusionsFor(
      editToken,
      offered.filter((c) => !kept.has(c.normKey)).map((c) => c.normKey),
    );
    setVaultDecisionFor(editToken, "yes");
    refreshVaultCover();
    captureIfMine();
  }

  /** Back out of the chooser. Deliberately records NOTHING: you opened it to
   *  decide and didn't, so the question is still open and the banner returns on
   *  the next edit. */
  function cancelVaultPicker() {
    vaultPicker.value = null;
  }

  // Enter in a row's name opens the NEXT row right below it (todo-list flow):
  // the same blank-row machinery as "Add an item", but positioned after the
  // source row instead of at the folder's end, so mid-list entry stays in place.
  function addBlankItemAfter(afterId: string): string {
    const src = snapshot.value?.items.find((i) => i.id === afterId);
    if (!src) return "";
    // the new row is a SIBLING of src — a child if src is nested, else top-level
    const parentId = src.parentId ?? null;
    const sibs = siblingItems(snapshot.value!.items, src.folderId, parentId).sort(bySortOrder);
    const next = sibs[sibs.findIndex((s) => s.id === afterId) + 1];
    const id = parentId ? addChild(parentId) : addBlankItem(src.folderId);
    if (id && next) moveItem(id, src.folderId, next.id, parentId);
    return id;
  }
  // A row that's still untouched-empty removes itself when focus leaves it (the
  // row calls this on focusout). Quiet — no undo toast: nothing was typed, so
  // nothing is lost. Emptiness is verified against the snapshot HERE, not just
  // in the caller's view, so a stale event can never discard a row with content.
  function discardEmpty(id: string) {
    const it = snapshot.value?.items.find((i) => i.id === id);
    if (!it) return;
    if (
      it.name.trim() !== "" || it.unitWeightMg > 0 || it.qty !== 1 ||
      it.commonName || it.description || it.catalogItemId != null ||
      it.classification != null || it.wornQty != null || it.packed ||
      snapshot.value?.items.some((c) => c.parentId === id) // has nested children
    ) return;
    if (pendingBlankId.value === id) pendingBlankId.value = null;
    // quiet: nothing was ever typed here, so "Removed 1 item" in the history would
    // be describing a row that never existed as far as anyone is concerned
    dispatch({ t: "removeItem", id, quiet: true });
  }
  function updateItem(id: string, patch: ItemPatch) {
    // any real edit means this row is no longer an untouched blank to clean up
    if (pendingBlankId.value === id) pendingBlankId.value = null;
    dispatch({ t: "updateItem", id, patch });
  }
  function removeItem(id: string) {
    const item = snapshot.value?.items.find((i) => i.id === id);
    // removing a parent cascades to its children (reducer) — capture them so undo can
    // restore the whole group
    const kids = (snapshot.value?.items ?? []).filter((i) => i.parentId === id).map((i) => ({ ...i }));
    dispatch({ t: "removeItem", id });
    if (item) {
      const saved = { ...item };
      offerUndo(item.name || "Item", () => {
        dispatch({ t: "addItem", item: saved }); // parent first, so children re-link
        for (const k of kids) dispatch({ t: "addItem", item: k });
      });
    }
  }
  function setItemWeight(id: string, raw: string) {
    if (!snapshot.value) return;
    // clearing the weight clears the remembered unit with it — an empty field has
    // named nothing, and leaving a stale "oz" behind would relabel the next entry
    if (raw.trim() === "")
      return updateItem(id, { unitWeightMg: 0, weightOverridden: true, entryUnit: null });

    // The unit this row is currently READING in — the one printed beside the field.
    // It has to be the parse default, not the list's: on a row showing "3.8 oz",
    // typing a bare "4.2" means 4.2 ounces. Defaulting to the list unit there would
    // silently reinterpret the number as grams and the row would jump.
    const current = snapshot.value.items.find((i) => i.id === id)?.entryUnit;
    const readingIn = current ?? snapshot.value.displayUnit;

    const mg = parseWeightInput(raw, readingIn);
    if (mg === null) return;
    updateItem(id, {
      unitWeightMg: mg,
      weightOverridden: true,
      // naming a unit re-labels the row; a bare number (or a compound, which names
      // no single unit) leaves the label exactly as it was — so arrow-stepping and
      // editing just the digits both keep the row in the unit you chose.
      entryUnit: entryUnitFromInput(raw) ?? current ?? null,
    });
  }

  // ---- nesting ----
  // The wrap/unwrap pair and the reindexing move live in useGearListNesting —
  // they answer to nothing but the snapshot and the queue, and their group
  // semantics were the longest stretch of this file that had nothing to do with
  // syncing. Covered by tests/itemNesting.nuxt.test.ts.
  const { addChild, nestItem, unnest, moveItem } = createNesting({
    snapshot,
    dispatch,
    pendingBlankId,
    // hoisted function declaration, so passing it here — above its own definition
    // — is safe, and it stays the one implementation both paths share
    discardEmpty,
  });

  async function rotate(): Promise<string | null> {
    try {
      const res = await $fetch<{ editToken: string }>("/api/edit/rotate", {
        method: "POST",
        headers: authHeaders(),
      });
      const old = editToken;
      const oldCode = claimCode;
      editToken = res.editToken;
      // A rotate hands THIS device the new link whichever way it was holding the
      // list — so a claimed open graduates to the token path here, and the editor
      // behaves from now on exactly as if the link had been opened directly.
      claimCode = "";
      openedByCode.value = false;
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
      if (decision !== "ask") setVaultDecisionFor(editToken, decision);
      const declined = vaultExclusionsFor(old);
      if (declined.size) setVaultExclusionsFor(editToken, [...declined]);
      clearVaultDecisionFor(old);
      refreshVaultCover(); // mirror the carried answer onto the rows
      const my = useMyLists();
      const prev = my.entries.value.find((e) => e.editToken === old);
      // always persist the NEW token, even if the old registry entry was missing,
      // so a rotate can never strand the only copy of the write capability — built
      // from the snapshot by the same mapping registerCreated uses
      const base =
        prev ??
        (snapshot.value
          ? my.entryFromSnapshot({ editToken: res.editToken, snapshot: snapshot.value }, totals.value?.totalMg ?? 0)
          : null);
      if (old) my.forget(old); // also drops the old token's on-device record
      // the claimed open's record re-keys onto the token; leaving the code-keyed
      // copy behind would resurface pre-rotate state on the next claimed open
      if (oldCode) store.del(claimedLocalKey(oldCode));
      if (base) my.upsert({ ...base, editToken: res.editToken, lastOpened: Date.now() });
      persistLocal(); // re-key this device's copy onto the new token
      return res.editToken;
    } catch {
      return null;
    }
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
    // the on-device copy below and drains on the next open. A dead token
    // (remoteMissing) would only 404, so don't bother.
    if (pending.length && (editToken || claimCode) && !remoteMissing) {
      $fetch("/api/edit/mutate", { method: "POST", headers: authHeaders(), body: { ops: pending.slice(0, 500) } }).catch(() => {});
    }
    // capture the latest state on device before teardown — the debounced persist
    // may not have fired, and SPA nav / unmount must not drop the last edits
    writeLocal();
    clearTimeout(persistTimer);
    epoch++; // invalidate any in-flight flush/poll responses
    // drop any in-flight drag (item or folder) so it can't commit against a new list
    useItemDnd().reset();
    useFolderDnd().reset();
    stopPoll();
    clearTimeout(undoTimer);
    pendingUndo.value = null;
    teardownListeners?.();
    snapshot.value = null;
    editToken = "";
    claimCode = "";
    openedByCode.value = false;
    resetSession();
    status.value = "idle";
  }

  return {
    snapshot, totals, status,
    get editToken() { return editToken; },
    get claimCode() { return claimCode; },
    get epoch() { return epoch; },
    openedByCode,
    authHeaders,
    load, startDraft, dispose, rotate,
    setMeta, setUnit, addFolder, updateFolder, removeFolder, moveFolderBefore,
    addDay, updateDay, removeDay,
    addPerson, updatePerson, removePerson,
    addWaypoint, updateWaypoint, removeWaypoint, ensureRouteEnds,
    vaultPrompt, answerVaultPrompt,
    vaultPicker, confirmVaultPicker, cancelVaultPicker,
    vaultAuto, vaultDeclined,
    addBlankItem, addBlankItemAfter, addVaultItem, addVaultFolder, saveItemToVault, discardEmpty, updateItem, removeItem, setItemWeight, moveItem,
    addChild, nestItem, unnest,
    pendingBlankId, pendingUndo, undoRemove, holdUndo, releaseUndo,
  };
}

export function useGearList() {
  if (!singleton) singleton = create();
  return singleton;
}
