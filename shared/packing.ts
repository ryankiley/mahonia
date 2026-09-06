// Packing-mode ticks: what a row's box STANDS FOR, and what a tick on it writes.
//
// A leaf's box is its own tick. A GROUP's box (a row with children nested under it)
// is its children's: it reads checked when every child in view is packed, mixed when
// some are, clear when none, and a tick on it packs or unpacks all of them. The
// group's own `packed` flag is not a fact the view draws while it has children in
// view: a container is packed when what's in it is. The box used to record the
// group's own flag instead, which let it read checked over six unchecked rows (Ryan,
// 2026-09-06, a toiletry bag with everything still out of it) and gave it no way to
// say "some".
//
// "In view" is the person filter: the children a narrowed editor shows, or all of
// them. The filter reaches the rows only as CSS (see usePersonFilter), so a tick on a
// group has to decide for itself which children it may write. One that reached rows
// the filter was hiding would pack someone else's gear on their behalf.
//
// Nothing here reconciles the group's own flag from its children, deliberately. The
// count and the box both derive, so a stored flag on a group would be a number
// nothing on screen reads, and carriesContent (shared/weights) treats `packed` as
// something a person put on the row: a group flagged by its children would then
// outlive its last child instead of dissolving with it (unwrapEmptied).
import type { Item } from "./types";
import { effectivePersonId, UNASSIGNED, type PersonSelection } from "./people";

export type TickState = "checked" | "mixed" | "clear";

/**
 * The children a person selection keeps on screen under a group: all of them for the
 * everyone view, else those whose EFFECTIVE carrier (their own, else the group's, the
 * one inherit rule in shared/people) is the selected person, or nobody under
 * UNASSIGNED. The same answer the editor's CSS filter and the read views'
 * visibleItemsForPerson give, so a box never counts a row the page isn't showing.
 */
export function childrenInView<T extends Pick<Item, "personId">>(
  group: Pick<Item, "personId">,
  children: readonly T[],
  selection: PersonSelection,
): readonly T[] {
  if (!selection) return children;
  const wanted = selection === UNASSIGNED ? undefined : selection;
  return children.filter((ch) => effectivePersonId(ch, group) === wanted);
}

/**
 * What a row's box shows. With children in view it is theirs: all, some or none
 * packed. Without (a leaf, or a group whose children are all someone else's under the
 * filter), the box is the row's own line and shows its own flag.
 */
export function tickState(
  item: Pick<Item, "packed">,
  childrenInView: readonly Pick<Item, "packed">[],
): TickState {
  if (!childrenInView.length) return item.packed ? "checked" : "clear";
  const packed = childrenInView.filter((ch) => ch.packed).length;
  return packed === childrenInView.length ? "checked" : packed ? "mixed" : "clear";
}

/**
 * The rows a tick on the box writes: the children in view for a group, the row
 * itself otherwise. The mirror of tickState, so what a tick changes is exactly what
 * the box was reading, and pressing a mixed box packs the rest rather than clearing
 * the ones already in.
 */
export function tickTargets<T extends Pick<Item, "packed">>(
  item: T,
  childrenInView: readonly T[],
): readonly T[] {
  return childrenInView.length ? childrenInView : [item];
}

/**
 * The rows a progress count is over: those whose box stands for its own line, which
 * is every row with no child among `items`. Pass the FILTERED items (the strict set a
 * person view counts, filterItemsForPerson), so a group whose children are all
 * someone else's counts as its own line, exactly as its box reads under that filter.
 * A group with children in the set is not a check of its own: its box is theirs, and
 * counting it too made a six-item group seven ticks.
 */
export function countedForPacking<T extends Pick<Item, "id" | "parentId">>(
  items: readonly T[],
): T[] {
  const parents = new Set<string>();
  for (const it of items) if (it.parentId) parents.add(it.parentId);
  return items.filter((it) => !parents.has(it.id));
}
