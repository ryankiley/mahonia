// Who carries what — the display and filter rules for a list's people, written
// ONCE. The editor rows, the read-only rows, the exporters and the per-person
// totals all answer "whose is this item?" and "which items are Sam's?", and a
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

/**
 * Has a selection stopped resolving? A person removed, or the unassigned bucket
 * emptied (or the crew dissolved, which retires the bucket too) — in the editor by
 * your own edit, on a live read view by the owner's. Either way a filter aimed at
 * nothing strands the viewer on a blank list under a chips row with nothing lit,
 * so both surfaces widen back to everyone on the same rule.
 */
export function personSelectionGone(
  selection: PersonSelection,
  people: Person[],
  hasUnassigned: boolean,
): boolean {
  if (!selection) return false;
  return selection === UNASSIGNED
    ? !people.length || !hasUnassigned
    : !people.some((p) => p.id === selection);
}

/**
 * The key a person's NAME is compared on. Trimmed and case-folded, because "Sam"
 * and "sam " are one person to everyone who reads the list — and, more sharply,
 * one column value to the CSV exporter, whose Person column carries the name and
 * nothing else. Two people sharing a name make that column ambiguous and the
 * round-trip lossy, so the name is an identity here, not a label.
 */
const personNameKey = (name: string): string => name.trim().toLowerCase();

/**
 * Is `name` already spoken for? `exceptId` excuses the person being renamed, so
 * re-saving your own name isn't a collision with yourself.
 */
export function personNameTaken(
  people: Person[] | undefined,
  name: string,
  exceptId?: string,
): boolean {
  const key = personNameKey(name);
  return !!people?.some((p) => p.id !== exceptId && personNameKey(p.name) === key);
}

/**
 * Make a whole crew's names unique, in place, by numbering the repeats — for the
 * BULK paths (a raw create, a JSON backup, a hand-edited file) where the reducer's
 * one-at-a-time refusal never ran. Suffixes rather than drops: these people carry
 * gear, and removing one would unassign their rows. Lists written before the rule
 * existed come through here too, which is the point.
 */
export function uniquifyPersonNames(people: Person[]): Person[] {
  const seen = new Set<string>();
  for (const p of people) {
    if (!seen.has(personNameKey(p.name))) {
      seen.add(personNameKey(p.name));
      continue;
    }
    // " 2", " 3", … until free. Bounded by MAX_PEOPLE, so this can't spin.
    for (let n = 2; ; n++) {
      const candidate = `${p.name} ${n}`;
      if (seen.has(personNameKey(candidate))) continue;
      p.name = candidate;
      seen.add(personNameKey(candidate));
      break;
    }
  }
  return people;
}

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
  return slotInSorted(sortedPeople(people), id);
}

/** personSlot for a caller that already holds the people in display order — a row
 *  inside a list that sorted them once — so answering per row doesn't re-sort the
 *  list per row. Same answer, same "nobody" null. */
export function slotInSorted(sorted: readonly Person[], id: string | undefined): number | null {
  if (!id) return null;
  const slot = sorted.findIndex((p) => p.id === id);
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
  // ONE bucketing pass, not a filter per key: the chips recompute this on every
  // keystroke (the snapshot mutates in place), and thirteen filterItemsForPerson
  // calls each rebuilt the parent map over the whole list.
  const byId = new Map(list.items.map((i) => [i.id, i]));
  const buckets = new Map<string, Item[]>();
  for (const it of list.items) {
    const key = effectivePersonId(it, it.parentId ? byId.get(it.parentId) : null) ?? UNASSIGNED;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(it);
    else buckets.set(key, [it]);
  }
  const out: Record<string, number> = {};
  for (const key of [...(list.people ?? []).map((p) => p.id), UNASSIGNED]) {
    const items = buckets.get(key);
    if (!items) continue;
    const mg = computeTotals({ folders: list.folders, items }).totalMg;
    if (mg > 0) out[key] = mg;
  }
  return out;
}
