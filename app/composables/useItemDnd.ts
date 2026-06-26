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

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.userSelect = "";
    const id = dragId.value;
    const target = drop.value;
    dragId.value = null;
    drop.value = null;
    if (id && target) useGearList().moveItem(id, target.folderId, target.beforeId);
  }

  function start(itemId: string, ev: PointerEvent) {
    ev.preventDefault();
    dragId.value = itemId;
    drop.value = null;
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return { dragId, drop, start };
}

export function useItemDnd() {
  if (!singleton) singleton = create();
  return singleton;
}
