import type { Op } from "~~/shared/ops";
import { applyOps } from "~~/shared/ops";
import { uid } from "~~/shared/id";
import { nextFolderColor, STARTER_FOLDERS } from "~~/shared/categories";
import { DRAFT_KEY, localKey, rebaseOnto } from "~~/shared/localList";
import type { Folder, Item, ListSnapshot, Unit } from "~~/shared/types";
import { bySortOrder, computeTotals, itemsInFolder, parseWeightInput } from "~~/shared/weights";

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
  let pending: Op[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let isEditing = false;
  // bumped on every load/dispose so in-flight responses for a previous list are ignored
  let epoch = 0;
  let teardownListeners: (() => void) | undefined;

  // on-device durability + connectivity awareness. The connectivity ref + watcher
  // live in a DETACHED effect scope so they track for the singleton's whole life,
  // not just while the editor component happens to be mounted (this controller
  // outlives any single mount).
  const store = useLocalListStore();
  const scope = effectScope(true);
  const online = scope.run(() => useOnline())!;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  // Write the current snapshot + queue to IndexedDB under this list's key (its edit
  // token, or the draft slot before first save). Best-effort: the store swallows its
  // own failures, so this never throws into the edit path. No-ops with no snapshot.
  function writeLocal() {
    if (!snapshot.value) return;
    store.set(localKey(editToken), {
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
      if (!editToken) {
        if (hasRealContent(snapshot.value)) createFromDraft();
      } else if (pending.length) {
        scheduleFlush();
      } else if (status.value === "offline") {
        status.value = "synced";
      }
    });
  });

  // single-level undo for destructive removes — drives the "Undo" toast
  const pendingUndo = ref<{ label: string; restore: () => void } | null>(null);
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  function offerUndo(label: string, restore: () => void) {
    pendingUndo.value = { label, restore };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => (pendingUndo.value = null), 6000);
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

  function authHeaders() {
    return { Authorization: `Bearer ${editToken}` } as Record<string, string>;
  }

  function syncRegistry() {
    if (!snapshot.value) return;
    useMyLists().touch(editToken, {
      title: snapshot.value.title,
      version: snapshot.value.version,
      totalMg: computeTotals(snapshot.value).totalMg,
    });
  }

  async function load(token: string) {
    epoch++;
    const myEpoch = epoch;
    editToken = token;
    pending = [];
    inFlight = false;
    isEditing = false;
    clearTimeout(flushTimer);
    snapshot.value = null;
    status.value = "loading";
    installListeners();

    // Hydrate from this browser's local copy first — instant paint, and the only
    // thing we can show if the network is down. Restore its un-acked queue too.
    const local = await store.get(localKey(token));
    if (myEpoch !== epoch) return; // a newer load() superseded this one
    if (local) {
      snapshot.value = local.snapshot;
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
      syncRegistry();
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
      persistLocal();
      if (pending.length) scheduleFlush();
      startPoll();
    } catch (e: any) {
      if (myEpoch !== epoch) return;
      if (e?.statusCode === 404) {
        // The server has no list under this token (deleted, or the link was
        // rotated). If we still hold a local copy, keep it on screen so the data
        // is readable/exportable, but don't poll or flush against a dead token.
        status.value = local ? "synced" : "missing";
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

  // A list "has content" once any item carries a name or a weight. We don't persist
  // a draft (or count it as a keepable list) until then — opening the site and
  // bouncing leaves no row behind.
  function hasRealContent(s: ListSnapshot) {
    return s.items.some((i) => i.name.trim() !== "" || i.unitWeightMg > 0);
  }

  // Open a fresh, NOT-yet-persisted list (starter folders, no items). It lives only
  // in memory until the first real content lands (createFromDraft), so a visitor who
  // never adds anything never creates a server row.
  function startDraft() {
    epoch++;
    const myEpoch = epoch;
    editToken = "";
    pending = [];
    inFlight = false;
    isEditing = false;
    clearTimeout(flushTimer);
    installListeners();
    const folders: Folder[] = STARTER_FOLDERS.map((p, i) => ({
      id: uid(),
      name: p.name,
      colorKey: p.colorKey,
      defaultClassification: p.defaultClassification,
      sortOrder: i,
    }));
    snapshot.value = {
      title: "Untitled list",
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
      snapshot.value = local.snapshot;
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
    if (inFlight || editToken || !snapshot.value) return;
    // offline: the draft is already persisted locally; create once back online
    if (!online.value) { status.value = "offline"; return; }
    const myEpoch = epoch;
    inFlight = true;
    status.value = "saving";
    try {
      const s = snapshot.value;
      const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>("/api/lists/create", {
        method: "POST",
        body: { title: s.title, displayUnit: s.displayUnit, data: { folders: s.folders, items: s.items } },
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
      const token = useMyLists().registerCreated(res, computeTotals(merged).totalMg);
      if (typeof history !== "undefined") history.replaceState(history.state, "", `/e#${token}`);
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
    // optimistic: same reducer as the server
    applyOps(snapshot.value, [op]);
    snapshot.value = { ...snapshot.value };
    persistLocal(); // mirror to IndexedDB so this edit survives a reload/crash
    // Draft (no token yet): keep edits local until there's real content, then create
    // the list once. While that create is in flight, queue ops for the post-create flush.
    if (!editToken) {
      if (inFlight) pending.push(op);
      else if (hasRealContent(snapshot.value)) createFromDraft();
      return;
    }
    pending.push(op);
    scheduleFlush();
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 450);
  }

  async function flush() {
    if (inFlight || !pending.length || !snapshot.value) return;
    // offline: leave the queue intact + persisted; the online watcher re-flushes
    if (!online.value) { status.value = "offline"; persistLocal(); return; }
    const myEpoch = epoch;
    const ops = pending;
    pending = [];
    inFlight = true;
    status.value = "saving";
    try {
      const res = await $fetch<{ snapshot: ListSnapshot }>("/api/edit/mutate", {
        method: "POST",
        headers: authHeaders(),
        body: { ops },
      });
      if (myEpoch !== epoch) return; // controller moved to a different list
      if (!isEditing) {
        // adopt the authoritative merged snapshot, then re-apply ops queued while
        // this request was in flight (rebase) so nothing is lost or clobbered.
        const merged = res.snapshot;
        if (pending.length) applyOps(merged, pending);
        snapshot.value = merged;
      }
      // While mid-edit: keep local content AND do NOT advance the local version,
      // so the post-blur poll (since < server version) still delivers the merge.
      status.value = "synced";
      syncRegistry();
      persistLocal(); // snapshot adopted + queue drained → update the on-device copy
    } catch (e: any) {
      if (myEpoch !== epoch) return;
      pending = ops.concat(pending); // re-queue (incl. 409 contention) and retry shortly
      // offline surfaces honestly; a genuine server error keeps the "Not saved" cue
      status.value = online.value ? "error" : "offline";
      persistLocal(); // keep the re-queued ops on device until they land
      setTimeout(scheduleFlush, 1500);
    } finally {
      if (myEpoch === epoch) {
        inFlight = false;
        if (pending.length) scheduleFlush();
      }
    }
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!online.value) return; // nothing to pull while the connection is down
      if (inFlight || pending.length || !snapshot.value || useItemDnd().dragId.value != null) return;
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
          useItemDnd().dragId.value == null
        ) {
          snapshot.value = res.snapshot;
          syncRegistry();
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
    // on device (IndexedDB), so only nag when a server sync is pending AND reachable
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if ((pending.length || inFlight) && online.value) { e.preventDefault(); e.returnValue = ""; }
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
  const setMeta = (patch: Partial<{ title: string; description: string; displayUnit: Unit }>) =>
    dispatch({ t: "setMeta", patch });
  const setUnit = (displayUnit: Unit) => setMeta({ displayUnit });

  function addFolder(name = "New folder") {
    const folders = snapshot.value?.folders ?? [];
    const colorKey = nextFolderColor(folders.map((f) => f.colorKey ?? "other"));
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
    without.forEach((f, idx) => {
      if (f.sortOrder !== idx) updateFolder(f.id, { sortOrder: idx });
    });
  }
  function removeFolder(id: string) {
    const folder = snapshot.value?.folders.find((f) => f.id === id);
    const items = itemsInFolder(snapshot.value?.items ?? [], id).map((i) => ({ ...i }));
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
  // a normal row has) and focuses it; discardBlank cleans it up if abandoned.
  function addBlankItem(folderId: string): string {
    if (!snapshot.value) return "";
    const id = uid();
    const sortOrder = itemsInFolder(snapshot.value.items, folderId).length;
    const item: Item = { id, folderId, name: "", unitWeightMg: 0, qty: 1, classification: null, sortOrder };
    dispatch({ t: "addItem", item });
    pendingBlankId.value = id;
    return id;
  }
  function discardBlank(id: string) {
    if (pendingBlankId.value !== id) return;
    pendingBlankId.value = null;
    dispatch({ t: "removeItem", id }); // quiet — no undo toast for an abandoned blank
  }
  function updateItem(id: string, patch: Partial<Item>) {
    // any real edit means this row is no longer an untouched blank to clean up
    if (pendingBlankId.value === id) pendingBlankId.value = null;
    dispatch({ t: "updateItem", id, patch });
  }
  function removeItem(id: string) {
    const item = snapshot.value?.items.find((i) => i.id === id);
    dispatch({ t: "removeItem", id });
    if (item) {
      const saved = { ...item };
      offerUndo(item.name || "Item", () => dispatch({ t: "addItem", item: saved }));
    }
  }
  function setItemWeight(id: string, raw: string) {
    if (!snapshot.value) return;
    if (raw.trim() === "") return updateItem(id, { unitWeightMg: 0, weightOverridden: true });
    const mg = parseWeightInput(raw, snapshot.value.displayUnit);
    if (mg !== null) updateItem(id, { unitWeightMg: mg, weightOverridden: true });
  }
  // Drag-to-reorder: move item `id` into `folderId`, positioned before `beforeId`
  // (null = append to that folder's end). Reindexes the target folder to clean
  // 0..n-1 integers in the new order — collision-proof and self-healing against
  // any pre-existing duplicate sortOrders (which would otherwise re-sort
  // ambiguously on reload). One moveItem op per item that actually shifts; all
  // batched into a single flush.
  function moveItem(id: string, folderId: string | null, beforeId: string | null) {
    if (!snapshot.value) return;
    const it = snapshot.value.items.find((i) => i.id === id);
    if (!it) return;
    const target = itemsInFolder(snapshot.value.items, folderId)
      .filter((i) => i.id !== id)
      .sort(bySortOrder);
    let idx = beforeId == null ? target.length : target.findIndex((s) => s.id === beforeId);
    if (idx < 0) idx = target.length;
    const ordered = [...target.slice(0, idx), it, ...target.slice(idx)];
    ordered.forEach((item, i) => {
      const moved = item.id === id ? item.folderId !== folderId || item.sortOrder !== i : item.sortOrder !== i;
      if (moved) dispatch({ t: "moveItem", id: item.id, folderId, sortOrder: i });
    });
  }

  async function rotate(): Promise<string | null> {
    try {
      const res = await $fetch<{ editToken: string }>("/api/edit/rotate", {
        method: "POST",
        headers: authHeaders(),
      });
      const old = editToken;
      editToken = res.editToken;
      const my = useMyLists();
      const prev = my.entries.value.find((e) => e.editToken === old);
      // always persist the NEW token, even if the old registry entry was missing,
      // so a rotate can never strand the only copy of the write capability
      const base =
        prev ??
        (snapshot.value
          ? {
              shareCode: snapshot.value.shareCode,
              slug: snapshot.value.slug,
              title: snapshot.value.title,
              totalMg: computeTotals(snapshot.value).totalMg,
              version: snapshot.value.version,
            }
          : null);
      my.forget(old); // also drops the old token's on-device record
      if (base) my.upsert({ ...base, editToken: res.editToken, lastOpened: Date.now() } as any);
      persistLocal(); // re-key this device's copy onto the new token
      return res.editToken;
    } catch {
      return null;
    }
  }

  function dispose() {
    // best-effort: flush unsynced edits before teardown (SPA nav / unmount) so
    // queued ops aren't silently dropped on the way out
    if (pending.length && editToken) {
      $fetch("/api/edit/mutate", { method: "POST", headers: authHeaders(), body: { ops: pending } }).catch(() => {});
    }
    // capture the latest state on device before teardown — the debounced persist
    // may not have fired, and SPA nav / unmount must not drop the last edits
    writeLocal();
    clearTimeout(persistTimer);
    epoch++; // invalidate any in-flight flush/poll responses
    useItemDnd().reset(); // drop any in-flight drag so it can't commit against a new list
    stopPoll();
    clearTimeout(flushTimer);
    clearTimeout(undoTimer);
    pendingUndo.value = null;
    teardownListeners?.();
    snapshot.value = null;
    pending = [];
    editToken = "";
    inFlight = false;
    isEditing = false;
    status.value = "idle";
  }

  return {
    snapshot, totals, status,
    get editToken() { return editToken; },
    load, startDraft, dispose, rotate,
    setMeta, setUnit, addFolder, updateFolder, removeFolder, moveFolderBefore,
    addBlankItem, discardBlank, updateItem, removeItem, setItemWeight, moveItem,
    pendingBlankId, pendingUndo, undoRemove,
  };
}

export function useGearList() {
  if (!singleton) singleton = create();
  return singleton;
}
