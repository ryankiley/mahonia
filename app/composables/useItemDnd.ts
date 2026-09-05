// Pointer-based drag-to-reorder AND re-nest for item rows. Mouse + touch (Pointer
// Events). Vertical drag picks the slot; HORIZONTAL drag changes nesting, the
// the outliner model: drag right past a threshold to nest under the row above,
// drag left to pop back out to top level. The threshold is measured from where the
// gesture STARTED (not an absolute x), so it works no matter where on the row you
// grab — and it only counts on a move that still READS as horizontal (see `renest`).
// Rows expose `data-item-id` + `data-parent` (absent/null = top-level),
// folders expose `data-folder`; the drop commits via useGearList().moveItem on
// pointerup. The dragged row isn't live-reordered — a drop indicator shows where it
// lands, keeping the DOM stable. The gesture lifecycle (capture, listeners, cancels)
// is the shared createPointerDrag scaffold.
//
// One level only (mirrors the indent/outdent buttons + the reducer's hasKids guard):
// a row that already has children can't be nested, and you can't nest under a row
// that is itself nested.

// horizontal travel from the gesture's start x (px) needed to change nesting level.
// Unchanged at 24 — what keeps a reorder from re-nesting by accident is not this
// number but the out-runs-the-vertical test at `renest` below, for which this is only
// the floor.
const NEST_THRESHOLD = 24;

// The dragId an INSERTING drag carries — one that brings something in from outside
// the list rather than moving a row already in it (today: the vault pane). Everything
// downstream of the drop target — the insertion line, the folder tail, the
// collapse-clip lift — is identical either way, so it runs through this same gesture
// rather than a parallel one that would have to grow its own copy of each indicator.
// A sentinel rather than a real id: no row is ever `dragId`, so no row dims itself as
// the source, which is right — the source is still sitting there. The leading space
// keeps it clear of any uuid while staying truthy for pointerDrag's `if (dragId)`.
const INSERT_SOURCE = " insert";

interface DropTarget {
  folderId: string | null;
  beforeId: string | null; // item to insert before; null = append to the container's end
  parentId: string | null; // the container's parent (null = top-level)
  /** Set when the drag INSERTS rather than moves: the source's own commit, called
   *  with the resolved slot. A closure, not a payload this module would have to
   *  understand — so the vault's own rules (its duplicate check, its addVaultItem
   *  call) stay in the pane that owns them, and this file, which sits in the
   *  editor's first-load chunk, never imports shared/vault or the catalog-search
   *  fold behind it. It rides on the TARGET rather than in a ref because
   *  createPointerDrag reads target() and then reset()s before calling commit(). */
  insert?: (folderId: string | null, beforeId: string | null) => void;
}

let singleton: ReturnType<typeof create> | undefined;

function create() {
  // shallowRef: a target is replaced whole, never mutated, and a deep proxy over it
  // bought nothing but a wrapped object for every reader
  const drop = shallowRef<DropTarget | null>(null);
  // Write the target only when it CHANGES. `track` runs on every pointermove
  // (~60/s), and every row's isDropBefore / isNestAppendTarget / isNestParent
  // hangs off `drop` — so a fresh object per move, even one describing the same
  // slot, recomputed all of them at pointer rate for a slot that hadn't moved.
  function setDrop(next: DropTarget | null) {
    const cur = drop.value;
    if (
      cur === next ||
      (cur &&
        next &&
        cur.folderId === next.folderId &&
        cur.parentId === next.parentId &&
        cur.beforeId === next.beforeId &&
        cur.insert === next.insert)
    )
      return;
    drop.value = next;
  }
  // The lifted row's wrap element for the gesture in flight. Its vertical offset from
  // the pickup point (the "carry" feel) is written straight onto it as --drag-dy every
  // move — an imperative style write, not a ref: only the row's own CSS transform
  // consumes it, and routing it through reactivity re-rendered the whole dragged row
  // per pointermove just to deliver a number to a style attribute.
  let dragEl: HTMLElement | null = null;
  let startY = 0;
  let startX = 0;
  // the insert commit for the gesture in flight, when it came from outside the list.
  // A plain local, not a ref — it's read only inside the pointermove handler below,
  // never by a template or computed.
  let pendingInsert: DropTarget["insert"];

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

  // Top-level rows of a folder (skip nested children, which carry data-parent), minus
  // the dragged row itself — and minus anything the person filter has display:none'd.
  // A hidden row can never WIN a slot (its zero-height rect fails slotFor's test),
  // but it still occupied an index, and the nest candidate below is picked BY index —
  // so without this a rightward drag could nest under a row nobody can see.
  function topRowsOf(folderEl: HTMLElement, dragId: string): HTMLElement[] {
    // `skip` is the row that will VACATE its slot — the dragged one on a move, and
    // nobody on a copy, because a copy leaves its source exactly where it is. Excluding
    // the source from a copy's slot math collapsed a whole row-height band onto one
    // answer: every position from the row above's midpoint to the row below's returned
    // the same slot, the insertion line was drawn a row below the pointer, and the slot
    // directly ABOVE the source was unreachable — you could not copy a row to the
    // position just above itself.
    const skip = drag.copyKey.value ? null : dragId;
    return ([...folderEl.querySelectorAll("[data-item-id]")] as HTMLElement[]).filter(
      (r) =>
        r.getAttribute("data-item-id") !== skip &&
        !r.getAttribute("data-parent") &&
        r.getBoundingClientRect().height > 0,
    );
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
    // An INSERTING drag brings a new row in from outside the list, so there is no move
    // for a copy to be an alternative to and `commit` ignores the modifier entirely.
    // Saying so here rather than at the commit keeps the CURSOR honest too — otherwise
    // Alt held over a vault drag promised a copy the drop would never perform.
    copyable: (id) => id !== INSERT_SOURCE,
    track(ev, el, dragId) {
      dragEl?.style.setProperty("--drag-dy", `${ev.clientY - startY}px`);

      // ---- inserting from outside: no row to reorder, so no nesting and no sibling
      // flow. Land it at a top-level slot in whatever folder is under the pointer. ----
      if (pendingInsert) {
        // over the source pane itself → no target, so releasing there cancels rather
        // than committing to whichever folder happens to sit behind it
        if (el?.closest("[data-vault-pane]")) {
          setDrop(null);
          return;
        }
        const overFolder = folderUnder(el, ev.clientY);
        if (!overFolder || overFolder.hasAttribute("data-collapsed")) return;
        const rows = topRowsOf(overFolder, dragId);
        setDrop({
          folderId: overFolder.getAttribute("data-folder") || null,
          parentId: null,
          beforeId: idOf(rows[slotFor(rows, ev.clientY)]),
          insert: pendingInsert,
        });
        return;
      }

      // read only on the reorder path — an inserting drag returned above without
      // needing either, and this runs on every pointermove. Through toRaw: the two
      // scans below are plain loops over plain objects that way, instead of a
      // proxy get (and a dependency track) per item per move.
      const dx = ev.clientX - startX;
      const snap = toRaw(useGearList().snapshot.value);
      const dragged = snap?.items.find((i) => i.id === dragId);
      if (!dragged) return;

      // Which way this move re-nests, if at all: -1 out to top level, +1 in under the
      // row above, 0 neither — and 0 is the ordinary vertical reorder.
      //
      // Re-nesting is a HORIZONTAL gesture, so it counts only while the drag still
      // READS as one: the travel across has to clear the threshold AND out-run the
      // travel down. The threshold on its own — which is all `dx <= -NEST_THRESHOLD`
      // used to be — is not a gesture, it is a distance, so any reorder of a few rows
      // inside a group eventually wandered into it and the row popped out to top
      // level. On a phone that isn't even wander: the grip sits at the row's right
      // edge and a thumb dragging down sweeps left, so reordering within a group
      // un-nested it nearly every time. Same in mirror image for nesting IN, which
      // rightward drift could trigger just as easily.
      //
      // Re-read on EVERY move, deliberately — and this is the whole subtlety. Latching
      // it instead (commit once, hold until the pointer comes back inside the
      // threshold) reads better and is wrong: it arms on the first sample where the
      // across-travel happens to lead, which early in a gesture is nearly any of them,
      // and then rides out the entire descent. "Drift left, then descend" and "pull
      // out, then carry down" are the SAME cumulative shape, so no amount of
      // remembering can separate them — only the live reading can. The price is that
      // re-nesting a row and carrying it a long way down are two gestures rather than
      // one: the lead across has to still be there at the release. The drop indicator
      // says which of the two you are in, the whole way.
      const dy = ev.clientY - startY;
      // Structure edits stand down under a person filter, in BOTH directions. Nesting
      // in makes the row inherit a carrier and vanish from the very view being worked
      // in; un-nesting drops the carrier it had inherited, for the same disappearing
      // act, and can quietly take an emptied group with it. The indent menu stands
      // down the same way, in CSS (atoms/item.scss) — this is that rule for the drag.
      // Read at CALL time: this is a pointermove handler, so no row grows a
      // reactive subscription.
      const filterOn = usePersonFilter().selected.value != null;
      const renest =
        !filterOn && Math.abs(dx) >= NEST_THRESHOLD && Math.abs(dx) > Math.abs(dy) ? Math.sign(dx) : 0;

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

      // ---- still nested, and this move is no gesture out: reorder among siblings,
      // staying under the same parent (the original nested behavior) ----
      if (wasNested && renest !== -1) {
        const parentId = dragged.parentId!;
        const sibs = ([...document.querySelectorAll(`[data-parent="${parentId}"]`)] as HTMLElement[]).filter(
          // same rule as topRowsOf: only a MOVE vacates the source's slot
          (r) => drag.copyKey.value || r.getAttribute("data-item-id") !== dragId,
        );
        setDrop({
          folderId: dragged.folderId,
          parentId,
          beforeId: idOf(sibs[slotFor(sibs, ev.clientY)]),
        });
        return;
      }

      // ---- top-level flow: pick the slot among the folder's top-level rows ----
      const topRows = topRowsOf(folderEl, dragId);
      const slot = slotFor(topRows, ev.clientY);
      // the top-level row directly ABOVE the slot is the candidate to nest under
      const parentCandidate = slot > 0 ? topRows[slot - 1] : undefined;
      const candidateId = idOf(parentCandidate);

      // nest INTO the row above on a gesture rightward — but only a childless row can
      // be nested, and only under a real row above it. Otherwise land at top level.
      // (A person filter has already zeroed `renest`; see above.)
      // …and it must not become the row we nest INTO. The source is in the candidate
      // list on a copy (above), so without this a rightward copy-drag over the source's
      // own band would nest the copy under its own original.
      const nest = renest === 1 && !hasKids && candidateId != null && candidateId !== dragId;
      if (nest) {
        const kids = [...document.querySelectorAll(`[data-parent="${candidateId}"]`)].filter(
          (r) => r.getAttribute("data-item-id") !== dragId,
        ) as HTMLElement[];
        setDrop({ folderId, parentId: candidateId, beforeId: idOf(kids[slotFor(kids, ev.clientY)]) });
        return;
      }
      // plain top-level reorder / un-nest (a nested row that reached here escaped its parent)
      setDrop({ folderId, parentId: null, beforeId: idOf(topRows[slot]) });
    },
    target: () => drop.value,
    // Alt held at the release COPIES instead of moving — the Finder/Figma gesture,
    // and the one that makes a row costing four fields worth building once. The
    // source stays where it is; everything on it lands in the slot the indicator
    // was pointing at, children included. An INSERTING drag ignores the modifier:
    // it is already bringing a new row in, so there is no move for a copy to be an
    // alternative to.
    commit: (id, t, copy) =>
      t.insert
        ? t.insert(t.folderId, t.beforeId)
        : copy
          ? useGearList().duplicateItem(id, { folderId: t.folderId, beforeId: t.beforeId, parentId: t.parentId })
          : useGearList().moveItem(id, t.folderId, t.beforeId, t.parentId),
    onStart(ev) {
      drop.value = null;
      startY = ev.clientY;
      startX = ev.clientX;
      // an inserting drag has no row in the list to lift; a reorder starts on the
      // row's own grip, so the wrap is always an ancestor of the press target
      dragEl = pendingInsert ? null : ((ev.target as HTMLElement).closest?.<HTMLElement>(".item-wrap") ?? null);
    },
    onReset() {
      drop.value = null;
      dragEl?.style.removeProperty("--drag-dy");
      dragEl = null;
      pendingInsert = undefined;
    },
  });

  /**
   * Begin a drag that INSERTS a new row rather than moving an existing one. `insert`
   * is called once, on a committed drop, with the slot the pointer resolved to —
   * the caller owns what actually gets created and any rules about whether it may be.
   */
  function startInsert(insert: NonNullable<DropTarget["insert"]>, ev: PointerEvent) {
    pendingInsert = insert;
    drag.start(INSERT_SOURCE, ev);
  }

  // `copying` is live for the duration of a gesture. The drop-slot math above reads it
  // (a copy's source keeps its slot); the CURSOR is not its business — the scaffold
  // paints that on <html>, which is the only element that owns it while the pointer is
  // captured. The source row still lifts and follows the pointer during a copy, which
  // is deliberate: a gesture whose held object stayed put would read as broken.
  return { dragId: drag.dragId, copying: drag.copyKey, drop, start: drag.start, startInsert, reset: drag.reset };
}

export function useItemDnd() {
  if (!singleton) singleton = create();
  return singleton;
}
