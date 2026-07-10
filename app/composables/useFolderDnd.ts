// Pointer-based drag-to-reorder for FOLDERS (the grip handle in each folder
// header). Simpler than item DnD: folders only reorder within the one list. The
// dragged folder isn't live-moved — a drop indicator shows where it will land,
// and the commit happens on pointerup via useGearList().moveFolderBefore. The
// gesture lifecycle (capture, listeners, cancels) is the shared createPointerDrag
// scaffold.

export interface FolderDropTarget {
  targetId: string; // folder being hovered
  before: boolean; // insert before (true) or after (false) the target
}

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const drop = ref<FolderDropTarget | null>(null);

  const drag = createPointerDrag<FolderDropTarget>({
    track(ev, el, dragId) {
      const folderEl = el?.closest("[data-folder]") as HTMLElement | null;
      // in a gap / over the dragged folder itself → keep the last target, don't flicker
      if (!folderEl) return;
      const id = folderEl.getAttribute("data-folder");
      if (!id || id === dragId) return;
      // flip before/after at the HEADER's middle, not the whole folder's — a folder
      // full of items is tall, and its centre sits deep in the list, making the
      // "after" zone feel unreachable. The header is the handle, so judge from it.
      const head = (folderEl.querySelector(".folder__head") as HTMLElement | null) ?? folderEl;
      const rect = head.getBoundingClientRect();
      drop.value = { targetId: id, before: ev.clientY < rect.top + rect.height / 2 };
    },
    target: () => drop.value,
    commit: (id, t) => useGearList().moveFolderBefore(id, t.targetId, t.before),
    onStart: () => (drop.value = null),
    onReset: () => (drop.value = null),
  });

  return { dragId: drag.dragId, drop, start: drag.start, reset: drag.reset };
}

export function useFolderDnd() {
  if (!singleton) singleton = create();
  return singleton;
}
