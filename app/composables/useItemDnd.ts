// Pointer-based drag-to-reorder for item rows — within a folder and across
// folders. Mouse + touch (Pointer Events). Item rows expose `data-item-id`,
// folders expose `data-folder`; the drop commits via useGearList().moveItem on
// pointerup. The dragged row isn't live-reordered — a drop indicator shows where
// it will land, keeping the DOM stable during the drag. The gesture lifecycle
// (capture, listeners, cancels) is the shared createPointerDrag scaffold.

export interface DropTarget {
  folderId: string | null;
  beforeId: string | null; // item to insert before; null = append to folder end
}

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const drop = ref<DropTarget | null>(null);
  // live vertical offset of the lifted row from where it was picked up, so the
  // dragged item visibly tracks the pointer (the "carry" feel) instead of just
  // dimming in place. Pixels.
  const dy = ref(0);
  let startY = 0;

  const drag = createPointerDrag<DropTarget>({
    track(ev, el, dragId) {
      dy.value = ev.clientY - startY;
      const folderEl = el?.closest("[data-folder]") as HTMLElement | null;
      // off to the side / in a gap between folders → keep the last target rather than
      // dropping it, so the indicator doesn't flicker and a release still commits.
      if (!folderEl) return;
      // a collapsed folder hides its rows (display:none → zero-rect), so dropping here
      // would silently append into a folder you can't see, with no indicator. Treat it
      // as a gap and keep the last visible target.
      if (folderEl.hasAttribute("data-collapsed")) return;
      const folderId = folderEl.getAttribute("data-folder") || null;
      // pick the insertion point purely by vertical position among this folder's rows
      // (excluding the one being dragged): land before the first row whose middle is
      // below the pointer, else append. This makes the whole row band a target — no
      // need to land exactly on a row, and the header drops it at the top, not the end.
      const rows = [...folderEl.querySelectorAll("[data-item-id]")].filter(
        (r) => r.getAttribute("data-item-id") !== dragId,
      ) as HTMLElement[];
      let beforeId: string | null = null;
      for (const r of rows) {
        const rect = r.getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) {
          beforeId = r.getAttribute("data-item-id");
          break;
        }
      }
      drop.value = { folderId, beforeId };
    },
    target: () => drop.value,
    commit: (id, t) => useGearList().moveItem(id, t.folderId, t.beforeId),
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
