// Pointer-based drag-to-reorder for item rows — within a folder and across
// folders. Mouse + touch (Pointer Events). Item rows expose `data-item-id`,
// folders expose `data-folder`; the drop commits via useGearList().moveItem on
// pointerup. The dragged row isn't live-reordered — a drop indicator shows where
// it will land, keeping the DOM stable during the drag.

export interface DropTarget {
  folderId: string | null;
  beforeId: string | null; // item to insert before; null = append to folder end
}

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const dragId = ref<string | null>(null);
  const drop = ref<DropTarget | null>(null);
  // live vertical offset of the lifted row from where it was picked up, so the
  // dragged item visibly tracks the pointer (the "carry" feel) instead of just
  // dimming in place. Pixels.
  const dy = ref(0);
  let startY = 0;

  function nextItemId(folderEl: HTMLElement, row: HTMLElement): string | null {
    const rows = [...folderEl.querySelectorAll("[data-item-id]")] as HTMLElement[];
    for (let j = rows.indexOf(row) + 1; j < rows.length; j++) {
      const id = rows[j]!.getAttribute("data-item-id");
      if (id && id !== dragId.value) return id;
    }
    return null; // nothing after it → append
  }

  function onMove(ev: PointerEvent) {
    if (!dragId.value) return;
    dy.value = ev.clientY - startY;
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const folderEl = el?.closest("[data-folder]") as HTMLElement | null;
    if (!folderEl) {
      drop.value = null;
      return;
    }
    const folderId = folderEl.getAttribute("data-folder") || null;
    const row = el?.closest("[data-item-id]") as HTMLElement | null;
    if (row && row.getAttribute("data-item-id") !== dragId.value) {
      const rect = row.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      drop.value = {
        folderId,
        beforeId: before ? row.getAttribute("data-item-id") : nextItemId(folderEl, row),
      };
    } else {
      // over the folder but not a droppable row → append to its end
      drop.value = { folderId, beforeId: null };
    }
  }

  function detach() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
  }

  // Clear all drag state + listeners without committing. Safe to call any time
  // (re-entrant drag start, interrupted gesture, list dispose).
  function reset() {
    detach();
    if (typeof document !== "undefined") document.body.style.userSelect = "";
    dragId.value = null;
    drop.value = null;
    dy.value = 0;
  }

  function onUp() {
    const id = dragId.value;
    const target = drop.value;
    reset();
    if (id && target) useGearList().moveItem(id, target.folderId, target.beforeId);
  }

  // touch/OS can end a gesture with pointercancel (second finger, edge-swipe,
  // scroll steal) instead of pointerup — drop the drag, commit nothing.
  function onCancel() {
    reset();
  }

  function start(itemId: string, ev: PointerEvent) {
    if (dragId.value) reset(); // never stack a second gesture's listeners
    ev.preventDefault();
    dragId.value = itemId;
    drop.value = null;
    startY = ev.clientY;
    dy.value = 0;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  return { dragId, drop, dy, start, reset };
}

export function useItemDnd() {
  if (!singleton) singleton = create();
  return singleton;
}
