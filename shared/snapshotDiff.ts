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
import type { Folder, Item, ListData, ListState, TripDay } from "./types";

export interface ListDiff {
  meta?: Partial<Pick<ListState, "title" | "description" | "displayUnit" | "trailUrl" | "trailLabel" | "trailDistanceM" | "trailDistanceUnit" | "trailProfile" | "trailAscentM" | "trailDescentM" | "startDate" | "endDate">>;
  foldersUpsert?: Folder[]; // present in target and new-or-changed vs base
  foldersDel?: string[]; // ids in base, gone in target
  itemsUpsert?: Item[];
  itemsDel?: string[];
  daysUpsert?: TripDay[];
  daysDel?: string[];
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
  startDate?: string | null;
  endDate?: string | null;
  data: ListData;
}

export const stateToFullSnap = (s: ListState): FullSnap => ({
  title: s.title,
  description: s.description ?? null,
  displayUnit: s.displayUnit,
  trailUrl: s.trailUrl ?? null,
  trailLabel: s.trailLabel ?? null,
  trailDistanceM: s.trailDistanceM ?? null,
  trailDistanceUnit: s.trailDistanceUnit ?? null,
  trailProfile: s.trailProfile ?? null,
  trailAscentM: s.trailAscentM ?? null,
  trailDescentM: s.trailDescentM ?? null,
  startDate: s.startDate ?? null,
  endDate: s.endDate ?? null,
  data: { folders: s.folders, items: s.items, days: s.days ?? [] },
});
export const fullSnapToState = (s: FullSnap): ListState => ({
  title: s.title,
  description: s.description ?? "",
  displayUnit: s.displayUnit as ListState["displayUnit"],
  // undefined, not "" — these are optional on ListMeta, and an empty string would
  // round-trip a cleared link back as a present-but-blank field
  trailUrl: s.trailUrl ?? undefined,
  trailLabel: s.trailLabel ?? undefined,
  trailDistanceM: s.trailDistanceM ?? undefined,
  trailDistanceUnit: normalizeDistanceUnit(s.trailDistanceUnit),
  trailProfile: s.trailProfile ?? undefined,
  trailAscentM: s.trailAscentM ?? undefined,
  trailDescentM: s.trailDescentM ?? undefined,
  startDate: s.startDate ?? undefined,
  endDate: s.endDate ?? undefined,
  folders: s.data?.folders ?? [],
  items: s.data?.items ?? [],
  days: s.data?.days ?? [],
  version: 0, // not carried by snapshots — the row's own version column is authoritative
});

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

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
// stable equality for plain entity objects. A false "changed" (e.g. from key-order
// noise) only over-includes — safe — so this never drops a real change.
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Ops that turn `base` into `target`, as an entity-level delta. */
export function diffListState(base: ListState, target: ListState): ListDiff {
  const diff: ListDiff = {};

  const meta: NonNullable<ListDiff["meta"]> = {};
  if (base.title !== target.title) meta.title = target.title;
  if ((base.description ?? "") !== (target.description ?? "")) meta.description = target.description ?? "";
  if (base.displayUnit !== target.displayUnit) meta.displayUnit = target.displayUnit;
  // "" is the CLEAR sentinel (same shape description uses): a link removed between base
  // and target has to be recorded as a change, or restoring would resurrect it.
  if ((base.trailUrl ?? "") !== (target.trailUrl ?? "")) meta.trailUrl = target.trailUrl ?? "";
  if ((base.trailLabel ?? "") !== (target.trailLabel ?? "")) meta.trailLabel = target.trailLabel ?? "";
  // 0 is this field's clear sentinel — the numeric equivalent of the "" above. A real
  // distance is always positive (normalizeTrailDistanceM rejects the rest), so 0 can
  // only ever mean "removed", and it keeps the key a number rather than widening the
  // diff's type to carry a string that means nothing else.
  if ((base.trailDistanceM ?? 0) !== (target.trailDistanceM ?? 0)) meta.trailDistanceM = target.trailDistanceM ?? 0;
  // back to the "" sentinel: this one is a string, and "" (→ absent → follow the
  // weight unit) is a state a list can genuinely return to, so the removal has to
  // survive a restore just like a cleared link does
  if ((base.trailDistanceUnit ?? "") !== (target.trailDistanceUnit ?? "")) {
    meta.trailDistanceUnit = target.trailDistanceUnit ?? ("" as never);
  }
  // the route's shape takes the same clear sentinels — "" for the profile string, 0 for
  // the two heights. The reducer only ever deletes these keys (never stores an empty
  // profile or a zero climb), so a falsy value here can only mean "removed".
  if ((base.trailProfile ?? "") !== (target.trailProfile ?? "")) {
    meta.trailProfile = target.trailProfile ?? "";
  }
  if ((base.trailAscentM ?? 0) !== (target.trailAscentM ?? 0)) {
    meta.trailAscentM = target.trailAscentM ?? 0;
  }
  if ((base.trailDescentM ?? 0) !== (target.trailDescentM ?? 0)) {
    meta.trailDescentM = target.trailDescentM ?? 0;
  }
  // dates take the same "" clear sentinel: a trip whose dates were removed between
  // base and target has to record the removal, or a restore resurrects them
  if ((base.startDate ?? "") !== (target.startDate ?? "")) meta.startDate = target.startDate ?? "";
  if ((base.endDate ?? "") !== (target.endDate ?? "")) meta.endDate = target.endDate ?? "";
  if (Object.keys(meta).length) diff.meta = meta;

  const baseF = new Map(base.folders.map((f) => [f.id, f]));
  const foldersUpsert = target.folders.filter((f) => !baseF.has(f.id) || !same(baseF.get(f.id), f));
  const targetFIds = new Set(target.folders.map((f) => f.id));
  const foldersDel = base.folders.filter((f) => !targetFIds.has(f.id)).map((f) => f.id);
  if (foldersUpsert.length) diff.foldersUpsert = clone(foldersUpsert);
  if (foldersDel.length) diff.foldersDel = foldersDel;

  const baseI = new Map(base.items.map((i) => [i.id, i]));
  const itemsUpsert = target.items.filter((i) => !baseI.has(i.id) || !same(baseI.get(i.id), i));
  const targetIIds = new Set(target.items.map((i) => i.id));
  const itemsDel = base.items.filter((i) => !targetIIds.has(i.id)).map((i) => i.id);
  if (itemsUpsert.length) diff.itemsUpsert = clone(itemsUpsert);
  if (itemsDel.length) diff.itemsDel = itemsDel;

  // Days, the same entity-level shape — coerced on BOTH sides, because a snapshot taken
  // before days existed has no array at all and a restore must not throw on it.
  const baseDays = base.days ?? [];
  const targetDays = target.days ?? [];
  const baseD = new Map(baseDays.map((d) => [d.id, d]));
  const daysUpsert = targetDays.filter((d) => !baseD.has(d.id) || !same(baseD.get(d.id), d));
  const targetDIds = new Set(targetDays.map((d) => d.id));
  const daysDel = baseDays.filter((d) => !targetDIds.has(d.id)).map((d) => d.id);
  if (daysUpsert.length) diff.daysUpsert = clone(daysUpsert);
  if (daysDel.length) diff.daysDel = daysDel;

  return diff;
}

/** Reconstruct the target state: apply a delta on top of `base`. Order within each
 *  list is preserved from the target via the upsert objects' own positions — we
 *  rebuild the arrays so reconstruction matches the target exactly. */
export function applyListDiff(base: ListState, diff: ListDiff): ListState {
  const out = clone(base);
  if (diff.meta) {
    if (diff.meta.title !== undefined) out.title = diff.meta.title;
    if (diff.meta.description !== undefined) out.description = diff.meta.description;
    if (diff.meta.displayUnit !== undefined) out.displayUnit = diff.meta.displayUnit;
    // "" clears (see diffListState) — drop the key rather than storing a blank string,
    // so a restored state matches a never-set one exactly
    if (diff.meta.trailUrl !== undefined) {
      if (diff.meta.trailUrl) out.trailUrl = diff.meta.trailUrl;
      else delete out.trailUrl;
    }
    if (diff.meta.trailLabel !== undefined) {
      if (diff.meta.trailLabel) out.trailLabel = diff.meta.trailLabel;
      else delete out.trailLabel;
    }
    // 0 clears, exactly as "" does above
    if (diff.meta.trailDistanceM !== undefined) {
      if (diff.meta.trailDistanceM) out.trailDistanceM = diff.meta.trailDistanceM;
      else delete out.trailDistanceM;
    }
    if (diff.meta.trailDistanceUnit !== undefined) {
      const unit = normalizeDistanceUnit(diff.meta.trailDistanceUnit);
      if (unit) out.trailDistanceUnit = unit;
      else delete out.trailDistanceUnit;
    }
    if (diff.meta.trailProfile !== undefined) {
      if (diff.meta.trailProfile) out.trailProfile = diff.meta.trailProfile;
      else delete out.trailProfile;
    }
    if (diff.meta.trailAscentM !== undefined) {
      if (diff.meta.trailAscentM) out.trailAscentM = diff.meta.trailAscentM;
      else delete out.trailAscentM;
    }
    if (diff.meta.trailDescentM !== undefined) {
      if (diff.meta.trailDescentM) out.trailDescentM = diff.meta.trailDescentM;
      else delete out.trailDescentM;
    }
    if (diff.meta.startDate !== undefined) {
      if (diff.meta.startDate) out.startDate = diff.meta.startDate;
      else delete out.startDate;
    }
    if (diff.meta.endDate !== undefined) {
      if (diff.meta.endDate) out.endDate = diff.meta.endDate;
      else delete out.endDate;
    }
  }
  out.folders = mergeEntities(out.folders, diff.foldersUpsert, diff.foldersDel);
  out.items = mergeEntities(out.items, diff.itemsUpsert, diff.itemsDel);
  // `?? []` because `base` may predate days entirely — mergeEntities would iterate undefined
  out.days = mergeEntities(out.days ?? [], diff.daysUpsert, diff.daysDel);
  return out;
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
