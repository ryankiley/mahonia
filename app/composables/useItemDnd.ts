// Pointer-based drag-to-reorder AND re-nest for item rows. Mouse + touch (Pointer
// Events). Vertical drag picks the slot; HORIZONTAL drag changes nesting, the
// Workflowy/Notion model: drag right past a threshold to nest under the row above,
// drag left to pop back out to top level. The threshold is measured from where the
// gesture STARTED (not an absolute x), so it works no matter where on the row you
// grab. Rows expose `data-item-id` + `data-parent` (absent/null = top-level),
// folders expose `data-folder`; the drop commits via useGearList().moveItem on
// pointerup. The dragged row isn't live-reordered — a drop indicator shows where it
// lands, keeping the DOM stable. The gesture lifecycle (capture, listeners, cancels)
// is the shared createPointerDrag scaffold.
//
// One level only (mirrors the indent/outdent buttons + the reducer's hasKids guard):
// a row that already has children can't be nested, and you can't nest under a row
// that is itself nested. Nesting via drag is a MANUAL-folder gesture — in a
// name/weight-sorted folder the exact slot is moot, so a drag there stays a plain
// (append) reorder, same as before; un-nesting still works everywhere.

// horizontal travel from the gesture's start x (px) needed to change nesting level —
// large enough that a vertical drag with a little wobble never re-nests by accident
const NEST_THRESHOLD = 24;

export interface DropTarget {
  folderId: string | null;
  beforeId: string | null; // item to insert before; null = append to the container's end
  parentId: string | null; // the container's parent (null = top-level)
}

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const drop = ref<DropTarget | null>(null);
  // live vertical offset of the lifted row from where it was picked up, so the dragged
  // item visibly tracks the pointer (the "carry" feel) instead of just dimming. Pixels.
  const dy = ref(0);
  let startY = 0;
  let startX = 0;

  // the slot index (0..rows.length) where the dragged row would land, purely by
  // vertical position: before the first row whose middle is below the pointer, else end.
  function slotFor(rows: HTMLElement[], clientY: number): number {
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i]!.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return rows.length;
  }
  const idOf = (el: HTMLElement | undefined): string | null => el?.getAttribute("data-item-id") ?? null;

  // top-level rows of a folder (skip nested children, which carry data-parent), minus
  // the dragged row itself
  function topRowsOf(folderEl: HTMLElement, dragId: string): HTMLElement[] {
    return [...folderEl.querySelectorAll("[data-item-id]")].filter(
      (r) => r.getAttribute("data-item-id") !== dragId && !r.getAttribute("data-parent"),
    ) as HTMLElement[];
  }

  // the folder under the pointer — normally elementFromPoint's hit, but a rightward
  // nest drag lands in the horizontal gutter (past the row's right edge, where the
  // grip is), off any folder. Fall back to the folder whose vertical band holds the
  // pointer so nesting still resolves out there.
  function folderUnder(el: HTMLElement | null, clientY: number): HTMLElement | null {
    const direct = el?.closest("[data-folder]") as HTMLElement | null;
    if (direct) return direct;
    for (const f of document.querySelectorAll("[data-folder]")) {
      const r = f.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return f as HTMLElement;
    }
    return null;
  }

  const drag = createPointerDrag<DropTarget>({
    track(ev, el, dragId) {
      dy.value = ev.clientY - startY;
      const dx = ev.clientX - startX;
      const snap = useGearList().snapshot.value;
      const dragged = snap?.items.find((i) => i.id === dragId);
      if (!dragged) return;
      const wasNested = dragged.parentId != null;
      // a row with children can't be nested (one level only) — the reducer enforces it
      // too, but knowing here keeps the indicator honest
      const hasKids = snap!.items.some((i) => i.parentId === dragId);

      const folderEl = folderUnder(el, ev.clientY);
      // above the first folder / below the last → keep the last target rather than
      // dropping it, so the indicator doesn't flicker and a release still commits.
      if (!folderEl) return;
      // a collapsed folder hides its rows (zero-rect), so dropping here would silently
      // append into a folder you can't see. Treat it as a gap and keep the last target.
      if (folderEl.hasAttribute("data-collapsed")) return;
      const folderId = folderEl.getAttribute("data-folder") || null;
      const sorted = (folderEl.getAttribute("data-sort") || "manual") !== "manual";

      // ---- still nested + not dragged far enough left to escape: reorder among
      // siblings, staying under the same parent (the original nested behavior) ----
      if (wasNested && dx > -NEST_THRESHOLD) {
        const parentId = dragged.parentId!;
        const sibs = [...document.querySelectorAll(`[data-parent="${parentId}"]`)].filter(
          (r) => r.getAttribute("data-item-id") !== dragId,
        ) as HTMLElement[];
        drop.value = {
          folderId: dragged.folderId,
          parentId,
          beforeId: sorted ? null : idOf(sibs[slotFor(sibs, ev.clientY)]),
        };
        return;
      }

      // ---- top-level flow: pick the slot among the folder's top-level rows ----
      const topRows = topRowsOf(folderEl, dragId);
      const slot = slotFor(topRows, ev.clientY);
      // the top-level row directly ABOVE the slot is the candidate to nest under
      const parentCandidate = slot > 0 ? topRows[slot - 1] : undefined;
      const candidateId = idOf(parentCandidate);

      // nest INTO the row above when dragged right past the threshold — but only a
      // childless row can be nested, only under a real row above it, and not in a
      // sorted folder (slot is moot there). Otherwise land at top level.
      const nest = dx >= NEST_THRESHOLD && !hasKids && !sorted && candidateId != null;
      if (nest) {
        const kids = [...document.querySelectorAll(`[data-parent="${candidateId}"]`)].filter(
          (r) => r.getAttribute("data-item-id") !== dragId,
        ) as HTMLElement[];
        drop.value = { folderId, parentId: candidateId, beforeId: idOf(kids[slotFor(kids, ev.clientY)]) };
        return;
      }
      // plain top-level reorder / un-nest (a nested row that reached here escaped its parent)
      drop.value = { folderId, parentId: null, beforeId: sorted ? null : idOf(topRows[slot]) };
    },
    target: () => drop.value,
    commit: (id, t) => useGearList().moveItem(id, t.folderId, t.beforeId, t.parentId),
    onStart(ev) {
      drop.value = null;
      startY = ev.clientY;
      startX = ev.clientX;
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
