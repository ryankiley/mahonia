// Patch one snapshot IN PLACE until it equals another — how the editor adopts a
// server snapshot for the list it is already showing (a settled flush, a poll that
// pulled in a collaborator's edit).
//
// Why not `snapshot.value = merged`: that swaps the object behind the ref, so every
// row that receives the list as a prop re-renders and every computed reading it
// recomputes — after nearly every settled edit, which is exactly the repaint
// dispatch() takes care to avoid by mutating through the proxy. Writing only the
// differences through the SAME object keeps Vue's property-level tracking: a row the
// server didn't change is an object nothing touched, and it stays put.
//
// Entity rows are matched by id and updated field by field (assigning only what
// differs), missing rows are spliced out, new rows spliced in, and each array is
// reordered in place to match the source — never replaced. Meta fields are compared
// by value, and a key the source lacks is DELETED rather than left stale, because
// deleting is how the reducer itself clears an optional field (a removed trail link
// has no key, not a blank). Pure and framework-free: `target` is whatever the caller
// hands over, and when that is the reactive proxy, every write here goes through it.

import type { ListSnapshot } from "./types";

const ENTITY_KEYS = ["folders", "items", "days", "waypoints", "people"] as const;
type EntityKey = (typeof ENTITY_KEYS)[number];
const isEntityKey = (key: string): key is EntityKey => (ENTITY_KEYS as readonly string[]).includes(key);

type Row = { id: string };
type Fields = Record<string, unknown>;

// Value equality for one field. Primitives compare directly; anything nested (should a
// field ever hold an object) by its JSON, the same test snapshotDiff trusts — so a
// nested value that differs is replaced wholesale, never merged.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Make `target`'s own fields equal `source`'s: assign what differs, drop what's gone. */
function assignFields(target: Fields, source: Fields): void {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  for (const key of Object.keys(source)) if (!same(target[key], source[key])) target[key] = source[key];
}

/** Position of the row with `id` in `arr` at or after `from`, or -1. */
function indexFrom(arr: readonly Row[], id: string, from: number): number {
  for (let i = from; i < arr.length; i++) if (arr[i]!.id === id) return i;
  return -1;
}

/**
 * Bring one entity array to `next` in place. Rows the source dropped go first (walking
 * backwards, so each splice leaves the indices ahead of it intact); then a single pass
 * in source order puts each row at its slot — a row already there is updated where it
 * stands, one found later is moved up, one not found at all is inserted.
 */
function reconcileRows(arr: Row[], next: readonly Row[]): void {
  const keep = new Set(next.map((e) => e.id));
  for (let i = arr.length - 1; i >= 0; i--) if (!keep.has(arr[i]!.id)) arr.splice(i, 1);
  for (let i = 0; i < next.length; i++) {
    const src = next[i]!;
    if (arr[i]?.id !== src.id) {
      const j = indexFrom(arr, src.id, i + 1);
      if (j < 0) {
        arr.splice(i, 0, src); // new here; the source's own object is the row now
        continue;
      }
      arr.splice(i, 0, ...arr.splice(j, 1)); // out of order: move it up to its slot
    }
    assignFields(arr[i] as unknown as Fields, src as unknown as Fields);
  }
  if (arr.length > next.length) arr.splice(next.length); // can't happen after the drop pass; cheap insurance
}

/** Patch `target` in place until it equals `source` — see the header. */
export function reconcileSnapshot(target: ListSnapshot, source: ListSnapshot): void {
  const t = target as unknown as Fields;
  const s = source as unknown as Fields;
  // Meta: every field that isn't an entity list. Deleted when the source lacks it,
  // assigned when it differs — version and updatedAt move here too.
  for (const key of Object.keys(t)) if (!isEntityKey(key) && !(key in s)) delete t[key];
  for (const key of Object.keys(s)) if (!isEntityKey(key) && !same(t[key], s[key])) t[key] = s[key];
  // Entities. A list the source has no array for reads as empty (every reader takes
  // `?? []`), so the target's array is drained rather than the key dropped — its
  // identity survives for anything holding it. A list the target has no array for
  // is created only when the source has one.
  for (const key of ENTITY_KEYS) {
    const next = (source[key] as Row[] | undefined) ?? [];
    let arr = target[key] as Row[] | undefined;
    if (!arr) {
      if (!source[key]) continue;
      t[key] = [];
      arr = target[key] as Row[]; // re-read, so a reactive target hands back its proxy, not the raw array
    }
    reconcileRows(arr, next);
  }
}
