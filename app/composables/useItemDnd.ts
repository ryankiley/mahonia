// Pointer-based drag-to-reorder for item rows. Mouse + touch (Pointer Events). The
// gesture is LEVEL-AWARE: a top-level row reorders among top-level rows (and can cross
// folders); a nested row reorders only among its siblings (same parent, same folder).
// Re-parenting isn't a drag gesture — that's the indent/outdent actions — so a drag
// never changes an item's nesting, only its order. Rows expose `data-item-id` +
// `data-parent` (absent = top-level), folders expose `data-folder`; the drop commits via
// useGearList().moveItem on pointerup. The dragged row isn't live-reordered — a drop
// indicator shows where it lands, keeping the DOM stable. The gesture lifecycle (capture,
// listeners, cancels) is the shared createPointerDrag scaffold.

export interface DropTarget {
  folderId: string | null;
  beforeId: string | null; // item to insert before; null = append to the container's end
  parentId: string | null; // the container's parent (null = top-level) — never changes here
}

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const drop = ref<DropTarget | null>(null);
  // live vertical offset of the lifted row from where it was picked up, so the dragged
  // item visibly tracks the pointer (the "carry" feel) instead of just dimming. Pixels.
  const dy = ref(0);
  let startY = 0;

  // pick the insertion point among `rows` purely by vertical position: land before the
  // first row whose middle is below the pointer, else append (null).
  function beforeIdFor(rows: HTMLElement[], clientY: number): string | null {
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return r.getAttribute("data-item-id");
    }
    return null;
  }

  const drag = createPointerDrag<DropTarget>({
    track(ev, el, dragId) {
      dy.value = ev.clientY - startY;
      const dragged = useGearList().snapshot.value?.items.find((i) => i.id === dragId);
      const parentId = dragged?.parentId ?? null;

      // a nested row: reorder only among its siblings (rows with the same data-parent),
      // staying in its parent's folder. It can't leave the parent via drag (use outdent).
      if (parentId) {
        const rows = [...document.querySelectorAll(`[data-parent="${parentId}"]`)].filter(
          (r) => r.getAttribute("data-item-id") !== dragId,
        ) as HTMLElement[];
        drop.value = { folderId: dragged!.folderId, parentId, beforeId: beforeIdFor(rows, ev.clientY) };
        return;
      }

      // a top-level row: reorder among top-level rows of the folder under the pointer.
      const folderEl = el?.closest("[data-folder]") as HTMLElement | null;
      // off to the side / in a gap between folders → keep the last target rather than
      // dropping it, so the indicator doesn't flicker and a release still commits.
      if (!folderEl) return;
      // a collapsed folder hides its rows (zero-rect), so dropping here would silently
      // append into a folder you can't see. Treat it as a gap and keep the last target.
      if (folderEl.hasAttribute("data-collapsed")) return;
      const folderId = folderEl.getAttribute("data-folder") || null;
      // dropping into a folder on a name/weight sort: the exact position is moot — the
      // folder re-orders by its sort the moment it lands. Show the tail (append) indicator.
      const sortMode = folderEl.getAttribute("data-sort");
      if (sortMode && sortMode !== "manual") {
        drop.value = { folderId, beforeId: null, parentId: null };
        return;
      }
      // top-level rows only (skip nested children, which carry data-parent) — the header
      // drops at the top, an empty band appends.
      const rows = [...folderEl.querySelectorAll("[data-item-id]")].filter(
        (r) => r.getAttribute("data-item-id") !== dragId && !r.getAttribute("data-parent"),
      ) as HTMLElement[];
      drop.value = { folderId, beforeId: beforeIdFor(rows, ev.clientY), parentId: null };
    },
    target: () => drop.value,
    commit: (id, t) => useGearList().moveItem(id, t.folderId, t.beforeId, t.parentId),
    onStart(ev) {
      drop.value = null;
      startY = ev.clientY;
      dy.value = 0;
    },
    onReset() {
      drop.value = null;
      dy.value = 0;
    },
  });

  return { dragId: drag.dragId, drop, dy, start: drag.start, reset: drag.reset };
}

export function useItemDnd() {
  if (!singleton) singleton = create();
  return singleton;
}
