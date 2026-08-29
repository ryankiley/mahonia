// Who carries what — the display and filter rules for a list's people, written
// ONCE. The editor rows, the read-only rows, the exporters and the per-person
// totals all answer "whose is this item?" and "which items are Ryan's?", and a
// rule copied into each of those is the shape that lets the share view keep
// drawing an assignment after the editor stops (the itemMarks lesson). Pure and
// framework-free, like the rest of shared/.

import { categoryColor } from "./categories";
import type { Item, ListData, Person } from "./types";
import { bySortOrder, computeTotals } from "./weights";

/**
 * The filter's third state, beside "a person id" and null-for-everyone: rows
 * nobody has claimed yet. A sentinel rather than a Person because it isn't one —
 * it can't be renamed, colored or removed, and it must never collide with a real
 * id (real ids are uid()-minted; this word is reserved by convention).
 */
export const UNASSIGNED = "unassigned";

/** What the view is narrowed to: null = everyone, UNASSIGNED, or a person's id. */
export type PersonSelection = string | null;

/** People in display order. sortOrder is the order, array order is insertion. */
export function sortedPeople(people?: Person[]): Person[] {
  return [...(people ?? [])].sort(bySortOrder);
}

/**
 * A person's SLOT: their index in display order, or null when the id names
 * nobody. The slot, not the id, is what the rows and the editor body carry as
 * data-attributes — CSS can't compare one attribute against another, but a
 * closed set of MAX_PEOPLE slots can be enumerated statically in the stylesheet
 * (see the person filter in atoms/item.scss).
 */
export function personSlot(people: Person[] | undefined, id: string | undefined): number | null {
  if (!id) return null;
  const slot = sortedPeople(people).findIndex((p) => p.id === id);
  return slot === -1 ? null : slot;
}

/**
 * Whose item this EFFECTIVELY is: its own assignee, else its parent's. The one
 * place the inherit rule lives — whoever takes the tent takes its poles, unless
 * a pole row says otherwise. Nesting is one level deep, so one parent hop is the
 * whole resolution.
 */
export function effectivePersonId(
  item: Pick<Item, "personId">,
  parent?: Pick<Item, "personId"> | null,
): string | undefined {
  return item.personId ?? parent?.personId ?? undefined;
}

export function personName(people: Person[] | undefined, id: string | undefined): string | undefined {
  if (!id) return undefined;
  return people?.find((p) => p.id === id)?.name;
}

/** A person's CSS color — the folder recipe, so chips and dots read in both themes. */
export function personColor(person?: Person): string {
  return categoryColor(person?.colorKey ?? "other");
}

/**
 * The items a selection COUNTS: strict effective matching, so a per-person
 * total is exactly the weight on that person's back. UNASSIGNED keeps the rows
 * nobody has claimed. null returns the input untouched — the everyone view is
 * the list itself, at zero cost.
 *
 * Strict means a parent kept on screen only as context around a matching child
 * is NOT here — that's a rendering concern (the editor solves it in CSS with
 * :has(); the read-only views with visibleItemsForPerson below), and counting
 * the parent's own line would put someone else's weight in this person's total.
 */
export function filterItemsForPerson(items: Item[], selection: PersonSelection): Item[] {
  if (!selection) return items;
  const byId = new Map(items.map((i) => [i.id, i]));
  const wanted = selection === UNASSIGNED ? undefined : selection;
  return items.filter(
    (it) => effectivePersonId(it, it.parentId ? byId.get(it.parentId) : null) === wanted,
  );
}

/**
 * The items a selection SHOWS: the strict set above, plus a parent whose only
 * claim is a matching child — kept so that child still renders in its place
 * rather than orphaned. The read-only views render from this; totals never do.
 */
export function visibleItemsForPerson(items: Item[], selection: PersonSelection): Item[] {
  if (!selection) return items;
  const counted = filterItemsForPerson(items, selection);
  const keep = new Set(counted.map((i) => i.id));
  for (const it of counted) if (it.parentId) keep.add(it.parentId);
  return items.filter((it) => keep.has(it.id));
}

/**
 * Is there anything nobody has claimed? Drives the "Unassigned" chip, which
 * appears only while the answer is yes — a fully divided list doesn't offer a
 * filter for an empty bucket. Top-level rows only: a child with no assignee of
 * its own follows its parent, so it is unassigned exactly when its parent is.
 */
export function hasUnassignedTopLevel(items: Item[]): boolean {
  return items.some((it) => it.parentId == null && !it.personId);
}

/**
 * Each chip's carry, in milligrams: one entry per person id, plus UNASSIGNED for
 * the unclaimed bucket — the strict per-person sets through the ordinary
 * computeTotals, so a chip and the headline it filters to can never disagree.
 * Zero carries are omitted (a "0 g" suffix on a chip is noise, not a fact).
 * Written once for the editor's chips and the share views' — the two surfaces
 * format it in their own display unit.
 */
export function carriedTotalsMg(
  list: Pick<ListData, "folders" | "items" | "people">,
): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = [...(list.people ?? []).map((p) => p.id), UNASSIGNED];
  for (const key of keys) {
    const mg = computeTotals({
      folders: list.folders,
      items: filterItemsForPerson(list.items, key),
    }).totalMg;
    if (mg > 0) out[key] = mg;
  }
  return out;
}
