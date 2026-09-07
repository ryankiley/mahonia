// Packing-mode ticks: what a row's box STANDS FOR, and what a tick on it writes.
//
// ONE rule, resolved in one place: a box stands for the row's own line — unless the
// row is a bare group, which has no line of its own — plus every child of it the page
// is showing. `tickState` and `tickRows` are that sentence in the two forms the view
// needs (all / some / none of them packed, and the rows a tick writes). They resolve
// the same set through the same helper, so they cannot drift: what the box reads is
// always exactly what pressing it changes.
//
// The shapes that falls into:
//
//  • A LEAF stands for itself, exactly as it always did.
//
//  • A BARE GROUP — a container holding nothing of its own — stands for its children
//    and never for its own `packed`. A container is packed when what's in it is. That
//    flag used to be the box's whole story, which let a toiletry bag read checked over
//    six unchecked rows (Ryan, 2026-09-06) with no way to say "some".
//
//  • A group that CARRIES ITS OWN LINE — a weight or calories of its own, the
//    isBareGroup predicate in shared/weights — stands for BOTH. Its line is real gear
//    that has to go in the bag too, and this app's rule for such a row is already
//    written down over there: a control is not taken away from a number the row still
//    contributes. A tent body with its poles nested under it is two things to pack,
//    and one tick on the group is both of them.
//
//  • A bare group whose children are ALL someone else's under a person filter stands
//    for NOTHING, and says so ("none" — the view disables the box). It does NOT fall
//    back to its own flag. That fallback is what this file shipped with, and it was a
//    trap: the flag it wrote is one no view draws and no count counts, so the tick
//    vanished the instant the filter widened, nothing on screen could clear it again,
//    and it sat there keeping carriesContent (shared/weights) true — which is what
//    stops an emptied group from dissolving. One argument was being asked to carry two
//    different facts, "is this a group" and "which children are on screen"; they are
//    separate questions here now.
//
// "Showing" is the person filter. It reaches the rows only as CSS (see
// usePersonFilter), so a box has to work out for itself which children it may count
// and write — one that reached rows the filter is hiding would pack someone else's
// gear on their behalf, and would read "mixed" over a group whose every visible row
// was ticked. The nest COLLAPSE is deliberately not part of this: those are your own
// rows, folded away by you, and rolling them up under one tick is what the control is
// for — where a filtered-out row belongs to somebody else.
//
// Nothing here reconciles a group's stored flag from its children. The box and the
// count both derive, so a bare group's flag is inert rather than wrong; "Clear checks"
// still reaches it (GearEditor shows that button whenever anything in view is packed,
// precisely so a flag no box draws is never stranded).
import type { Item } from "./types";
import { matchesSelection, type PersonSelection } from "./people";
import { isBareGroup } from "./weights";

/** All, some, none — or "none", the box that stands for no row at all (see above). */
export type TickState = "checked" | "mixed" | "clear" | "none";

/** The fields a row must carry to answer "what does this box stand for". */
type TickItem = Pick<Item, "unitWeightMg" | "kcal" | "packed" | "personId">;

/**
 * Does this row's box stand for the row's OWN line? True for a leaf, and for a group
 * that carries a weight or calories of its own; false for a bare group, which is
 * nothing but the container around its children.
 */
const standsForOwnLine = (item: Pick<Item, "unitWeightMg" | "kcal">, hasChildren: boolean): boolean =>
  !isBareGroup(item, hasChildren);

/**
 * The children of `group` this page is showing: all of them in the everyone view, else
 * those whose EFFECTIVE carrier (their own, else the group's) is the selection. The
 * rule itself is shared/people's `matchesSelection` — the same predicate
 * filterItemsForPerson counts by — so the box, the totals and the CSS filter cannot
 * answer "whose row is this?" three different ways.
 */
const childrenInView = <T extends Pick<Item, "personId">>(
  group: Pick<Item, "personId">,
  children: readonly T[],
  selection: PersonSelection,
): readonly T[] =>
  selection ? children.filter((ch) => matchesSelection(ch, group, selection)) : children;

/**
 * What the box shows. Walks the row's children once without building a list — this
 * runs on every row on every filter flip and every tick, and the ARRAY it would
 * otherwise mint is a fresh identity each time, which would defeat the caching that
 * keeps an unchanged state from re-rendering its row. `tickRows` builds the list, at
 * click time, where an allocation is free.
 *
 * Not generic, unlike tickRows below: this returns a verdict rather than rows, so
 * nothing here needs the item and its children to be the same type — and requiring it
 * only made callers whose item is narrower than its children (a literal `packed: true`
 * in a test fixture, say) fail to unify, for no benefit.
 */
export function tickState(
  item: TickItem,
  children: readonly TickItem[],
  selection: PersonSelection,
): TickState {
  let total = 0;
  let packed = 0;
  if (standsForOwnLine(item, children.length > 0)) {
    total = 1;
    if (item.packed) packed = 1;
  }
  for (const ch of children) {
    if (selection && !matchesSelection(ch, item, selection)) continue;
    total++;
    if (ch.packed) packed++;
  }
  if (!total) return "none";
  return packed === total ? "checked" : packed ? "mixed" : "clear";
}

/**
 * The rows a tick on the box writes — the same set `tickState` just classified. Empty
 * exactly when that returned "none", so a box standing for nothing writes nothing.
 * Pressing a MIXED box packs the rest rather than clearing the ones already in: the
 * caller writes the value it was handed to every row here, skipping the ones already
 * there.
 */
export function tickRows<T extends TickItem>(
  item: T,
  children: readonly T[],
  selection: PersonSelection,
): readonly T[] {
  const inView = childrenInView(item, children, selection);
  if (!standsForOwnLine(item, children.length > 0)) return inView;
  return inView.length ? [item, ...inView] : [item];
}

/**
 * The rows a progress count is over: exactly the rows some visible box stands for, so
 * the bar and the boxes can never disagree. That is every row except a BARE GROUP,
 * whose box is its children's — counting it too made a six-item group seven ticks.
 *
 * `items` is the set being counted (the strict per-person set under a filter,
 * filterItemsForPerson); `all` is the whole list, and is what decides whether a row is
 * a group at all. The two differ under a filter, and the difference matters: a bare
 * group whose children are all someone else's has no children in the filtered set, so
 * counting off that set alone would call it a leaf and count it — a tick the filtered
 * view offers no box for, and a total that could never be reached.
 */
export function countedForPacking<T extends Pick<Item, "id" | "parentId" | "unitWeightMg" | "kcal">>(
  items: readonly T[],
  all: readonly T[] = items,
): T[] {
  const parents = new Set<string>();
  for (const it of all) if (it.parentId) parents.add(it.parentId);
  return items.filter((it) => standsForOwnLine(it, parents.has(it.id)));
}
