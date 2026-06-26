import type { Op } from "~~/shared/ops";
import { applyOps } from "~~/shared/ops";
import { uid } from "~~/shared/id";
import type { Classification, Folder, Item, ListSnapshot, Unit } from "~~/shared/types";
import { computeTotals, parseWeightInput } from "~~/shared/weights";

// Editor controller (one list open at a time → module singleton). Mutations are
// applied optimistically via the SAME op-reducer the server uses, queued, and
// flushed (debounced). A poll pulls other editors' merged changes live.

type Status = "idle" | "loading" | "saving" | "synced" | "missing" | "error";

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const snapshot = ref<ListSnapshot | null>(null);
  const status = ref<Status>("idle");
  let editToken = "";
  let pending: Op[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let isEditing = false;
  // bumped on every load/dispose so in-flight responses for a previous list are ignored
  let epoch = 0;
  let teardownListeners: (() => void) | undefined;

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
  function dismissUndo() {
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
    try {
      const res = await $fetch<{ snapshot: ListSnapshot }>("/api/edit/list", {
        headers: authHeaders(),
      });
      if (myEpoch !== epoch) return; // a newer load() superseded this one
      snapshot.value = res.snapshot;
      status.value = "synced";
      syncRegistry();
      startPoll();
    } catch (e: any) {
      if (myEpoch !== epoch) return;
      status.value = e?.statusCode === 404 ? "missing" : "error";
    }
  }

  function dispatch(op: Op) {
    if (!snapshot.value) return;
    // optimistic: same reducer as the server
    applyOps(snapshot.value as any, [op]);
    snapshot.value = { ...snapshot.value };
    pending.push(op);
    scheduleFlush();
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 450);
  }

  async function flush() {
    if (inFlight || !pending.length || !snapshot.value) return;
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
        if (pending.length) applyOps(merged as any, pending);
        snapshot.value = merged;
      }
      // While mid-edit: keep local content AND do NOT advance the local version,
      // so the post-blur poll (since < server version) still delivers the merge.
      status.value = "synced";
      syncRegistry();
    } catch (e: any) {
      if (myEpoch !== epoch) return;
      pending = ops.concat(pending); // re-queue (incl. 409 contention) and retry shortly
      status.value = "error";
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
    // warn before leaving with unsynced edits
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.length || inFlight) { e.preventDefault(); e.returnValue = ""; }
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
    const sortOrder = snapshot.value?.folders.length ?? 0;
    dispatch({ t: "addFolder", folder: { id: uid(), name, colorKey: "other", defaultClassification: "base", sortOrder } });
  }
  const updateFolder = (id: string, patch: Partial<Folder>) =>
    dispatch({ t: "updateFolder", id, patch });
  function removeFolder(id: string) {
    const folder = snapshot.value?.folders.find((f) => f.id === id);
    const items = (snapshot.value?.items.filter((i) => i.folderId === id) ?? []).map((i) => ({ ...i }));
    dispatch({ t: "removeFolder", id });
    if (folder) {
      const f = { ...folder };
      offerUndo(folder.name || "Folder", () => {
        dispatch({ t: "addFolder", folder: f });
        for (const it of items) dispatch({ t: "addItem", item: it });
      });
    }
  }

  function addItem(
    folderId: string,
    fields: {
      name: string;
      weight?: string; // free-typed, parsed with the list unit
      weightMg?: number; // resolved (e.g. from a catalog pick)
      qty?: number;
      brand?: string;
      catalogItemId?: number;
    },
  ) {
    const name = fields.name.trim();
    if (!name || !snapshot.value) return;
    const mg =
      fields.weightMg != null
        ? fields.weightMg
        : fields.weight
          ? (parseWeightInput(fields.weight, snapshot.value.displayUnit) ?? 0)
          : 0;
    const sortOrder = snapshot.value.items.filter((i) => i.folderId === folderId).length;
    const item: Item = {
      id: uid(),
      folderId,
      name,
      brand: fields.brand || undefined,
      unitWeightMg: mg,
      qty: fields.qty && fields.qty > 0 ? fields.qty : 1,
      classification: null,
      sortOrder,
      catalogItemId: fields.catalogItemId,
      // record the catalog weight at link time so a future catalog correction can nudge non-overridden items
      catalogWeightMgAtLink: fields.catalogItemId != null ? mg : undefined,
    };
    dispatch({ t: "addItem", item });
  }
  const updateItem = (id: string, patch: Partial<Item>) => dispatch({ t: "updateItem", id, patch });
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
    const target = snapshot.value.items
      .filter((i) => i.folderId === folderId && i.id !== id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
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
      my.forget(old);
      if (base) my.upsert({ ...base, editToken: res.editToken, lastOpened: Date.now() } as any);
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
    load, dispose, rotate,
    setMeta, setUnit, addFolder, updateFolder, removeFolder,
    addItem, updateItem, removeItem, setItemWeight, moveItem,
    pendingUndo, undoRemove, dismissUndo,
  };
}

export function useGearList() {
  if (!singleton) singleton = create();
  return singleton;
}
