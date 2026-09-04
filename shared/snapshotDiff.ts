// Snapshot deltas — store a recovery point as the CHANGE from a base state, not a
// full copy. Snapshots are full-list copies otherwise, so they dominate per-list
// storage; a delta that carries only the entities that actually changed is far
// smaller when a snapshot touched a handful of items.
//
// We diff at the ENTITY level (whole folder/item objects), not field level: an
// added-or-changed entity is stored as its full object and applied as an upsert,
// and a removed entity as its id. This makes reconstruction LOSSLESS and trivial
// (set-minus + upsert) with none of the field-clear edge cases the op-reducer has —
// and over-including an unchanged entity is harmless (it just re-sets the same
// value), so the diff can never silently lose a change.

import { normalizeDistanceUnit } from "./trailDistance";
import type { Folder, Item, ListData, ListMetaKey, ListState, Person, TripDay, Waypoint } from "./types";
import { LIST_META_KEYS } from "./types";

export interface ListDiff {
  meta?: Partial<Pick<ListState, ListMetaKey>>;
  foldersUpsert?: Folder[]; // present in target and new-or-changed vs base
  foldersDel?: string[]; // ids in base, gone in target
  itemsUpsert?: Item[];
  itemsDel?: string[];
  daysUpsert?: TripDay[];
  daysDel?: string[];
  waypointsUpsert?: Waypoint[];
  waypointsDel?: string[];
  peopleUpsert?: Person[];
  peopleDel?: string[];
}

/** A full snapshot payload (the legacy/anchor form — meta + reducer content). */
export interface FullSnap {
  title: string;
  description: string | null;
  displayUnit: string;
  trailUrl?: string | null;
  trailLabel?: string | null;
  trailDistanceM?: number | null;
  trailDistanceUnit?: string | null;
  // The route read off a GPX. It has to ride the chain like everything else: it is the
  // one field here the owner cannot retype from memory, so losing it on a restore means
  // finding the original file again.
  trailProfile?: string | null;
  trailAscentM?: number | null;
  trailDescentM?: number | null;
  // the one field an owner cannot retype — it came off a file they may no longer have
  routeGeometry?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  data: ListData;
}

// The five entity lists and the diff keys each one writes. One table on the way out
// (diffListState) and the same one on the way back (applyListDiff), so a sixth list
// arrives in one place rather than as two more hand-copied blocks.
type EntityKey = keyof Pick<ListData, "folders" | "items" | "days" | "waypoints" | "people">;
const ENTITY_LISTS: { key: EntityKey; upsert: keyof ListDiff; del: keyof ListDiff }[] = [
  { key: "folders", upsert: "foldersUpsert", del: "foldersDel" },
  { key: "items", upsert: "itemsUpsert", del: "itemsDel" },
  { key: "days", upsert: "daysUpsert", del: "daysDel" },
  { key: "waypoints", upsert: "waypointsUpsert", del: "waypointsDel" },
  { key: "people", upsert: "peopleUpsert", del: "peopleDel" },
];

// Every meta field rides the full-snapshot form as a nullable: absent → null on the
// way out, null → undefined on the way back — undefined, not "", because these are
// optional on ListMeta and an empty string would round-trip a cleared link back as a
// present-but-blank field. Two exceptions, stated where they apply below.
export const stateToFullSnap = (s: ListState): FullSnap => {
  const out = {} as Record<string, unknown>;
  for (const key of LIST_META_KEYS) out[key] = s[key] ?? null;
  // days/waypoints/people, coerced: a list written before they existed has no key at all
  out.data = { folders: s.folders, items: s.items, days: s.days ?? [], waypoints: s.waypoints ?? [], people: s.people ?? [] };
  return out as unknown as FullSnap;
};
export const fullSnapToState = (s: FullSnap): ListState => {
  const out = {} as Record<string, unknown>;
  for (const key of LIST_META_KEYS) out[key] = s[key] ?? undefined;
  out.description = s.description ?? ""; // the reducer stores a blank description as ""
  out.trailDistanceUnit = normalizeDistanceUnit(s.trailDistanceUnit); // re-validated, never trusted
  out.folders = s.data?.folders ?? [];
  out.items = s.data?.items ?? [];
  out.days = s.data?.days ?? [];
  out.waypoints = s.data?.waypoints ?? [];
  out.people = s.data?.people ?? [];
  out.version = 0; // not carried by snapshots — the row's own version column is authoritative
  return out as unknown as ListState;
};

/**
 * Reconstruct the state at `targetIndex` from a chain ordered NEWEST→OLDEST, where
 * the newest is a full `base` and older entries are reverse-deltas (each transforms
 * its immediately-newer reconstructed state into itself). A `base` row resets the
 * fold, so legacy all-full snapshots reconstruct as themselves. Returns null if the
 * chain is malformed (a diff with no preceding base).
 */
export function reconstructChainAt(
  chain: { kind: "base" | "diff"; snapshot: FullSnap | ListDiff }[],
  targetIndex: number,
): ListState | null {
  let state: ListState | null = null;
  for (let i = 0; i <= targetIndex && i < chain.length; i++) {
    const row = chain[i]!;
    if (row.kind === "base") state = fullSnapToState(row.snapshot as FullSnap);
    else if (state) state = applyListDiff(state, row.snapshot as ListDiff);
    else return null; // diff with no anchor — should never happen (newest is always base)
  }
  return state;
}

// Inputs here are plain (DB rows and reconstructed states, never a Vue proxy), so the
// native clone is safe — and it doesn't drop an undefined-valued key the way a JSON
// round-trip would, which nothing downstream depends on either way.
const clone = <T>(v: T): T => structuredClone(v);
// stable equality for plain entity objects. A false "changed" (e.g. from key-order
// noise) only over-includes — safe — so this never drops a real change.
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// How each meta field is diffed and re-applied. The rule is uniform inside a group:
//
// STRING_META diffs on `?? ""`, and "" is the CLEAR sentinel (a link removed between
// base and target has to be recorded as a change, or restoring would resurrect it).
// On the way back, "" DROPS the key for the optional fields — a restored state must
// match a never-set one exactly — while title, description and displayUnit are
// assigned as-is: title and displayUnit are never absent, and a blank description is
// stored as "" by the reducer too. The dates and the route's shape (profile,
// geometry) take the same sentinel: "" (→ absent) is a state a list genuinely
// returns to, so the removal has to survive a restore just like a cleared link does.
//
// NUMBER_META diffs on `?? 0`, and 0 is that group's clear sentinel — the numeric
// equivalent of "". A real distance or climb is always positive (the normalizers
// reject the rest, and the reducer only ever DELETES these keys), so a 0 can only
// mean "removed", and it keeps the key a number rather than widening the diff's
// type to carry a string that means nothing else.
//
// trailDistanceUnit is a string that goes back in through its normalizer, so a
// value the chain carried is re-validated rather than trusted.
const ASSIGNED_META = ["title", "description", "displayUnit"] as const;
const STRING_META = [
  ...ASSIGNED_META,
  "trailUrl",
  "trailLabel",
  "trailProfile",
  "routeGeometry",
  "startDate",
  "endDate",
  "trailDistanceUnit",
] as const satisfies readonly ListMetaKey[];
const NUMBER_META = ["trailDistanceM", "trailAscentM", "trailDescentM"] as const satisfies readonly ListMetaKey[];

/** Ops that turn `base` into `target`, as an entity-level delta. */
export function diffListState(base: ListState, target: ListState): ListDiff {
  const diff: ListDiff = {};

  const meta: Record<string, unknown> = {};
  for (const key of STRING_META) {
    if ((base[key] ?? "") !== (target[key] ?? "")) meta[key] = target[key] ?? "";
  }
  for (const key of NUMBER_META) {
    if ((base[key] ?? 0) !== (target[key] ?? 0)) meta[key] = target[key] ?? 0;
  }
  if (Object.keys(meta).length) diff.meta = meta as ListDiff["meta"];

  // Every list coerced on BOTH sides: a snapshot taken before days, waypoints or
  // people existed has no array at all, and a restore must not throw on it.
  const out = diff as Record<string, unknown>;
  for (const { key, upsert, del } of ENTITY_LISTS) {
    const d = diffEntities<{ id: string }>(base[key] ?? [], target[key] ?? []);
    if (d.upsert.length) out[upsert] = clone(d.upsert);
    if (d.del.length) out[del] = d.del;
  }

  return diff;
}

/** Reconstruct the target state: apply a delta on top of `base`. Order within each
 *  list is preserved from the target via the upsert objects' own positions — we
 *  rebuild the arrays so reconstruction matches the target exactly. */
export function applyListDiff(base: ListState, diff: ListDiff): ListState {
  const out = clone(base) as unknown as Record<string, unknown>;
  if (diff.meta) {
    const meta = diff.meta as Record<string, unknown>;
    // "" and 0 clear (see the tables above) — drop the key rather than storing a
    // blank, so a restored state matches a never-set one exactly
    const put = (key: string, value: unknown) => {
      if (value) out[key] = value;
      else delete out[key];
    };
    for (const key of ASSIGNED_META) if (meta[key] !== undefined) out[key] = meta[key];
    for (const key of STRING_META) {
      if (meta[key] === undefined || (ASSIGNED_META as readonly string[]).includes(key)) continue;
      put(key, key === "trailDistanceUnit" ? normalizeDistanceUnit(meta[key]) : meta[key]);
    }
    for (const key of NUMBER_META) if (meta[key] !== undefined) put(key, meta[key]);
  }
  // `?? []` because `base` may predate a list entirely — mergeEntities would iterate undefined
  for (const { key, upsert, del } of ENTITY_LISTS) {
    out[key] = mergeEntities(
      (out[key] as { id: string }[] | undefined) ?? [],
      diff[upsert] as { id: string }[] | undefined,
      diff[del] as string[] | undefined,
    );
  }
  return out as unknown as ListState;
}

/**
 * One list of entities, diffed: what to upsert, and which ids went away.
 *
 * All five lists take the identical treatment — the rule at the top of this file is about
 * ENTITIES, not about folders — and mergeEntities below is already one function for all
 * five on the way back in. This is that symmetry on the way out; five hand-copied versions
 * of it is five places for the next list to arrive with a subtly different one.
 */
function diffEntities<T extends { id: string }>(
  baseArr: readonly T[],
  targetArr: readonly T[],
): { upsert: T[]; del: string[] } {
  const byId = new Map(baseArr.map((e) => [e.id, e]));
  const targetIds = new Set(targetArr.map((e) => e.id));
  return {
    upsert: targetArr.filter((e) => !byId.has(e.id) || !same(byId.get(e.id), e)),
    del: baseArr.filter((e) => !targetIds.has(e.id)).map((e) => e.id),
  };
}

// Apply deletes + upserts by id. Upserts replace in place (preserving order) or
// append; this reproduces the target's membership exactly. (Array ORDER is not
// load-bearing — folders/items render by their own sortOrder — so append-on-new is
// fine and round-trips by-id.)
function mergeEntities<T extends { id: string }>(
  baseArr: T[],
  upserts: T[] | undefined,
  dels: string[] | undefined,
): T[] {
  const delSet = new Set(dels ?? []);
  const byId = new Map<string, T>();
  for (const e of baseArr) if (!delSet.has(e.id)) byId.set(e.id, e);
  for (const e of upserts ?? []) byId.set(e.id, clone(e));
  return [...byId.values()];
}
