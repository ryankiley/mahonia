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

import type { Folder, Item, ListData, ListState } from "./types";

export interface ListDiff {
  meta?: Partial<Pick<ListState, "title" | "description" | "displayUnit" | "trailUrl" | "trailLabel">>;
  foldersUpsert?: Folder[]; // present in target and new-or-changed vs base
  foldersDel?: string[]; // ids in base, gone in target
  itemsUpsert?: Item[];
  itemsDel?: string[];
}

/** A full snapshot payload (the legacy/anchor form — meta + reducer content). */
export interface FullSnap {
  title: string;
  description: string | null;
  displayUnit: string;
  trailUrl?: string | null;
  trailLabel?: string | null;
  data: ListData;
}

export const stateToFullSnap = (s: ListState): FullSnap => ({
  title: s.title,
  description: s.description ?? null,
  displayUnit: s.displayUnit,
  trailUrl: s.trailUrl ?? null,
  trailLabel: s.trailLabel ?? null,
  data: { folders: s.folders, items: s.items },
});
export const fullSnapToState = (s: FullSnap): ListState => ({
  title: s.title,
  description: s.description ?? "",
  displayUnit: s.displayUnit as ListState["displayUnit"],
  // undefined, not "" — these are optional on ListMeta, and an empty string would
  // round-trip a cleared link back as a present-but-blank field
  trailUrl: s.trailUrl ?? undefined,
  trailLabel: s.trailLabel ?? undefined,
  folders: s.data?.folders ?? [],
  items: s.data?.items ?? [],
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
  }
  out.folders = mergeEntities(out.folders, diff.foldersUpsert, diff.foldersDel);
  out.items = mergeEntities(out.items, diff.itemsUpsert, diff.itemsDel);
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
