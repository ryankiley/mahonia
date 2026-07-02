// List repository — all DB access for lists. Capability-based: callers hold an
// edit token (write) or a share code (read); the internal numeric id never
// leaves this module.

import { createError } from "h3";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { catalogItems, lists, listSnapshots, type ListRow } from "../db/schema";
import {
  applyOps,
  MAX_FOLDERS,
  MAX_ITEMS,
  normalizeFolder,
  normalizeItem,
  type Op,
} from "../../shared/ops";
import { computeTotals } from "../../shared/weights";
import {
  diffListState,
  fullSnapToState,
  reconstructChainAt,
  stateToFullSnap,
  type FullSnap,
} from "../../shared/snapshotDiff";
import type { ListData, ListSnapshot, ListState, Unit } from "../../shared/types";
import { ensureSnapshotSchema, useDb } from "./db";
import { randomEditToken, randomShareCode, randomSlug, sha256Hex } from "./tokens";
import { stageCandidates, type CandidateObservation } from "./candidates";

type Db = Awaited<ReturnType<typeof useDb>>;

export function rowToSnapshot(row: ListRow): ListSnapshot {
  const data = (row.data ?? { folders: [], items: [] }) as ListData;
  return {
    shareCode: row.shareCode,
    slug: row.publicSlug,
    title: row.title,
    description: row.description ?? undefined,
    displayUnit: row.displayUnit as Unit,
    folders: data.folders ?? [],
    items: data.items ?? [],
    version: row.version,
    isPublic: row.isPublic,
  };
}

// Trickle-down: for items still linked to a catalog product (and not custom-
// renamed), display the catalog's CURRENT brand/name/variant rather than the flat
// snapshot baked in at add time — so catalog cleanups (e.g. variant normalization)
// reach existing lists. The stored snapshot is the fallback (removed/merged rows).
// Display-only: never written back to the list's `data` (mutations go through
// applyOps on the stored row), so storage stays the user's original snapshot.
export async function hydrateCatalogNames(db: Db, snap: ListSnapshot): Promise<ListSnapshot> {
  const ids = [
    ...new Set(
      snap.items
        .filter((i) => typeof i.catalogItemId === "number" && !i.nameOverridden)
        .map((i) => i.catalogItemId as number),
    ),
  ];
  if (!ids.length) return snap;
  const rows = await db
    .select({
      id: catalogItems.id,
      brand: catalogItems.brand,
      name: catalogItems.name,
      variant: catalogItems.variant,
    })
    .from(catalogItems)
    .where(and(inArray(catalogItems.id, ids), eq(catalogItems.status, "active")));
  if (!rows.length) return snap;
  const byId = new Map(rows.map((r) => [r.id, r]));
  snap.items = snap.items.map((it) => {
    if (it.catalogItemId == null || it.nameOverridden) return it;
    const c = byId.get(it.catalogItemId);
    if (!c) return it;
    return { ...it, brand: c.brand ?? undefined, name: c.name, variant: c.variant ?? undefined };
  });
  return snap;
}

function rowToState(row: ListRow): ListState {
  const data = (row.data ?? { folders: [], items: [] }) as ListData;
  return {
    title: row.title,
    description: row.description ?? undefined,
    displayUnit: row.displayUnit as Unit,
    folders: structuredClone(data.folders ?? []),
    items: structuredClone(data.items ?? []),
    version: row.version,
  };
}

const liveOnly = (col: typeof lists.editTokenHash | typeof lists.shareCode, val: string) =>
  and(eq(col, val), eq(lists.status, "active"), isNull(lists.deletedAt));

// Enforce the advertised case-insensitive Crockford contract + reject malformed
// codes before any DB round-trip.
const CROCKFORD_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
function normShareCode(raw: string): string | null {
  const c = (raw || "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  return CROCKFORD_RE.test(c) ? c : null;
}

async function findByEditToken(editToken: string, db?: Db): Promise<ListRow | null> {
  const d = db ?? (await useDb());
  const hash = sha256Hex(editToken);
  const rows = await d.select().from(lists).where(liveOnly(lists.editTokenHash, hash)).limit(1);
  return rows[0] ?? null;
}

// ---- snapshots (vandalism recovery for the shared-edit-link model) ----
// snapshots are full copies of the list, so they dominate per-list storage. Keep a
// small recent window (vandalism recovery rarely needs deep history) — at ~1/10min,
// 5 points cover ~50 min of active editing across sessions.
const SNAPSHOT_THROTTLE_MS = 10 * 60_000; // at most one auto-snapshot per list / 10 min
const SNAPSHOT_CAP = 5; // keep the most recent N per list (older are pruned)

/**
 * Insert a recovery point of `row`'s CURRENT state + prune to the cap. Best-effort
 * — NEVER throws (a snapshot failure must not break a write). The THROTTLE lives in
 * the caller (off the in-hand row's lastSnapshotAt) so the hot path needs no query.
 */
async function captureSnapshot(db: Db, row: ListRow, reason: string): Promise<void> {
  try {
    await ensureSnapshotSchema(db);
    const cur = rowToState(row);
    // The newest snapshot is the chain anchor (a full `base`). Demote it to a
    // reverse-delta against the new state, then insert the new full base on top —
    // so only the newest row is ever a full copy. Reconstruction folds newest→target
    // (see shared/snapshotDiff), and pruning only drops the oldest deltas (the anchor
    // is the newest, never pruned) — no rebasing needed.
    const newest = (
      await db
        .select()
        .from(listSnapshots)
        .where(eq(listSnapshots.listId, row.id))
        .orderBy(desc(listSnapshots.createdAt), desc(listSnapshots.id))
        .limit(1)
    )[0];
    if (newest && newest.kind === "base") {
      const prevState = fullSnapToState(newest.snapshot as FullSnap);
      await db
        .update(listSnapshots)
        .set({ kind: "diff", snapshot: diffListState(cur, prevState) })
        .where(eq(listSnapshots.id, newest.id));
    }
    await db.insert(listSnapshots).values({
      listId: row.id,
      kind: "base",
      snapshot: stateToFullSnap(cur),
      itemCount: cur.items.length,
      version: row.version,
      reason,
    });
    // prune oldest beyond the cap (id tie-breaks same-timestamp rows)
    const all = await db
      .select({ id: listSnapshots.id })
      .from(listSnapshots)
      .where(eq(listSnapshots.listId, row.id))
      .orderBy(desc(listSnapshots.createdAt), desc(listSnapshots.id));
    const stale = all.slice(SNAPSHOT_CAP).map((r) => r.id);
    if (stale.length) await db.delete(listSnapshots).where(inArray(listSnapshots.id, stale));
  } catch {
    /* best-effort: never block a write on snapshotting */
  }
}

/** Reconstruct the full state at a snapshot id by folding the chain newest→target. */
async function reconstructSnapshotState(
  db: Db,
  listId: number,
  targetId: number,
): Promise<ListState | null> {
  const rows = await db
    .select()
    .from(listSnapshots)
    .where(eq(listSnapshots.listId, listId))
    .orderBy(desc(listSnapshots.createdAt), desc(listSnapshots.id)); // newest→oldest
  const idx = rows.findIndex((r) => r.id === targetId);
  if (idx < 0) return null;
  return reconstructChainAt(
    rows.map((r) => ({ kind: r.kind === "diff" ? "diff" : "base", snapshot: r.snapshot })),
    idx,
  );
}

export interface SnapshotMeta {
  id: number;
  version: number;
  reason: string | null;
  createdAt: string;
  itemCount: number;
}

/** List a list's recovery points (newest first), edit-token-gated. */
export async function listSnapshotsByEditToken(
  editToken: string,
  db?: Db,
): Promise<SnapshotMeta[] | null> {
  const d = db ?? (await useDb());
  const row = await findByEditToken(editToken, d);
  if (!row) return null;
  await ensureSnapshotSchema(d);
  // partial select: this listing never reads the `snapshot` JSONB (the largest
  // column — a full list payload per row), so don't pull it over the wire
  const rows = await d
    .select({
      id: listSnapshots.id,
      version: listSnapshots.version,
      reason: listSnapshots.reason,
      createdAt: listSnapshots.createdAt,
      itemCount: listSnapshots.itemCount,
    })
    .from(listSnapshots)
    .where(eq(listSnapshots.listId, row.id))
    .orderBy(desc(listSnapshots.createdAt), desc(listSnapshots.id))
    .limit(SNAPSHOT_CAP);
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    reason: r.reason ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    itemCount: r.itemCount ?? 0,
  }));
}

/**
 * Restore a list to one of its snapshots (edit-token-gated). The current state is
 * snapshotted first ("before restore") so a restore is itself undoable. Returns
 * null when the token or snapshot id doesn't resolve to THIS caller's list (→ 404,
 * no cross-list oracle).
 */
export async function restoreSnapshotByEditToken(
  editToken: string,
  snapshotId: number,
  db?: Db,
): Promise<ListSnapshot | null> {
  const d = db ?? (await useDb());
  const owner = await findByEditToken(editToken, d);
  if (!owner) return null;
  await ensureSnapshotSchema(d);
  // verify the snapshot is THIS caller's list (no cross-list oracle), then
  // reconstruct its full state from the reverse-delta chain
  const owns = (
    await d
      .select({ id: listSnapshots.id })
      .from(listSnapshots)
      .where(and(eq(listSnapshots.id, snapshotId), eq(listSnapshots.listId, owner.id)))
      .limit(1)
  )[0];
  if (!owns) return null; // unknown id, or not this caller's list
  const s = await reconstructSnapshotState(d, owner.id, snapshotId);
  if (!s) return null;

  // re-normalize through the SAME reducer helpers (defensive — a snapshot must not
  // be a clamp-bypass back into raw JSONB), and re-validate the unit
  const data: ListData = {
    folders: (s.folders ?? []).slice(0, MAX_FOLDERS).map(normalizeFolder),
    items: (s.items ?? []).slice(0, MAX_ITEMS).map(normalizeItem),
  };
  const totals = computeTotals(data);
  const title = (s.title ?? "Untitled list").slice(0, 200);
  const displayUnit: Unit = (["g", "kg", "oz", "lb"] as Unit[]).includes(s.displayUnit as Unit)
    ? (s.displayUnit as Unit)
    : "g";

  // CAS like the mutate path: re-read + version-guard so a concurrent edit can't
  // be silently lost — and snapshot the CURRENT (fresh) state before overwriting,
  // so that edit is itself recoverable.
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await findByEditToken(editToken, d);
    if (!row) return null;
    await captureSnapshot(d, row, "before restore");
    const updated = await d
      .update(lists)
      .set({
        title,
        description: s.description ?? null,
        displayUnit,
        data,
        baseWeightMg: totals.baseMg,
        wornWeightMg: totals.wornMg,
        consumableWeightMg: totals.consumableMg,
        totalWeightMg: totals.totalMg,
        itemCount: totals.itemCount,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(lists.id, row.id), eq(lists.version, row.version)))
      .returning();
    if (updated[0]) return rowToSnapshot(updated[0]);
    // version moved under us — retry against the latest (re-capture the newer state)
  }
  throw createError({ statusCode: 409, statusMessage: "Restore contention — retry" });
}

export async function getByShareCode(code: string): Promise<ListSnapshot | null> {
  const c = normShareCode(code);
  if (!c) return null;
  const db = await useDb();
  const rows = await db.select().from(lists).where(liveOnly(lists.shareCode, c)).limit(1);
  return rows[0] ? hydrateCatalogNames(db, rowToSnapshot(rows[0])) : null;
}

export async function getByEditToken(editToken: string): Promise<ListSnapshot | null> {
  const db = await useDb();
  const row = await findByEditToken(editToken, db);
  return row ? hydrateCatalogNames(db, rowToSnapshot(row)) : null;
}

export async function versionByEditToken(editToken: string): Promise<number | null> {
  const db = await useDb();
  const hash = sha256Hex(editToken);
  const rows = await db
    .select({ version: lists.version })
    .from(lists)
    .where(liveOnly(lists.editTokenHash, hash))
    .limit(1);
  return rows[0]?.version ?? null;
}

export async function createList(init?: {
  title?: string;
  displayUnit?: Unit;
  data?: ListData;
}): Promise<{ editToken: string; snapshot: ListSnapshot }> {
  const db = await useDb();
  const editToken = randomEditToken();
  const editTokenHash = sha256Hex(editToken);
  const title = (init?.title ?? "Untitled list").slice(0, 200);
  // Normalize + cap inbound content through the SAME reducer helpers the mutate
  // path uses — the create path must not be a clamp-bypass into raw JSONB.
  const data: ListData = {
    folders: (init?.data?.folders ?? []).slice(0, MAX_FOLDERS).map(normalizeFolder),
    items: (init?.data?.items ?? []).slice(0, MAX_ITEMS).map(normalizeItem),
  };
  const totals = computeTotals(data);
  const displayUnit = init?.displayUnit ?? "g";

  // Retry on slug/share_code unique collision (regenerated each attempt).
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const inserted = await db
        .insert(lists)
        .values({
          publicSlug: randomSlug(title),
          editTokenHash,
          shareCode: randomShareCode(),
          title,
          displayUnit,
          data,
          baseWeightMg: totals.baseMg,
          wornWeightMg: totals.wornMg,
          consumableWeightMg: totals.consumableMg,
          totalWeightMg: totals.totalMg,
          itemCount: totals.itemCount,
          version: 1,
        })
        .returning();
      return { editToken, snapshot: rowToSnapshot(inserted[0]!) };
    } catch (e) {
      if ((e as { code?: string })?.code === "23505" && attempt < 4) continue;
      throw e;
    }
  }
  throw createError({ statusCode: 500, statusMessage: "Could not allocate list code" });
}

/**
 * Apply a batch of ops via compare-and-set on version. Ops MERGE: if another
 * editor bumped the version between read and write, we re-read and re-apply onto
 * the latest state (so independent edits both land). Returns the authoritative
 * snapshot, or null if the list doesn't exist (→ 404).
 */
export async function applyOpsByEditToken(
  editToken: string,
  ops: Op[],
  db?: Db,
): Promise<ListSnapshot | null> {
  const d = db ?? (await useDb());
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await findByEditToken(editToken, d);
    if (!row) return null;

    const state = rowToState(row);
    applyOps(state, ops);
    const data: ListData = { folders: state.folders, items: state.items };
    const totals = computeTotals(data);

    // Throttle off the in-hand row (no extra query). Stamping lastSnapshotAt in
    // the SAME CAS update serializes the decision by the version guard, so two
    // concurrent writers can't both snapshot (the loser retries + sees it set).
    const lastSnap = row.lastSnapshotAt ? new Date(row.lastSnapshotAt).getTime() : 0;
    const doSnapshot = Date.now() - lastSnap >= SNAPSHOT_THROTTLE_MS;

    const updated = await d
      .update(lists)
      .set({
        title: state.title,
        description: state.description ?? null,
        displayUnit: state.displayUnit,
        data,
        baseWeightMg: totals.baseMg,
        wornWeightMg: totals.wornMg,
        consumableWeightMg: totals.consumableMg,
        totalWeightMg: totals.totalMg,
        itemCount: totals.itemCount,
        version: row.version + 1,
        updatedAt: new Date(),
        ...(doSnapshot ? { lastSnapshotAt: new Date() } : {}),
      })
      .where(and(eq(lists.id, row.id), eq(lists.version, row.version)))
      .returning();

    if (updated[0]) {
      // pre-edit recovery point (best-effort; only ~once per throttle window)
      if (doSnapshot) await captureSnapshot(d, row, "edit");
      // community intake: stage typed (non-catalog) items touched by this batch so
      // the catalog can grow from real use. Best-effort — never break/slow a save.
      try {
        const touched = new Set<string>();
        for (const op of ops) {
          if (op.t === "addItem") touched.add(op.item.id);
          else if (op.t === "updateItem" && typeof op.patch?.name === "string") touched.add(op.id);
        }
        const typed: CandidateObservation[] = [];
        for (const it of state.items) {
          if (!touched.has(it.id) || it.catalogItemId != null || !it.name?.trim()) continue;
          typed.push({ brand: it.brand, name: it.name, weightMg: it.unitWeightMg, classification: it.classification });
        }
        if (typed.length) await stageCandidates(d, row.id, typed);
      } catch { /* intake must never break a list save */ }
      return hydrateCatalogNames(d, rowToSnapshot(updated[0]));
    }
    // version moved under us — retry against the latest
  }
  // extreme contention: refuse rather than silently drop the caller's ops.
  // The client's flush() catch re-queues and retries (no ops lost).
  throw createError({ statusCode: 409, statusMessage: "Save contention — retry" });
}

export async function rotateEditToken(editToken: string): Promise<string | null> {
  const db = await useDb();
  const row = await findByEditToken(editToken);
  if (!row) return null;
  const next = randomEditToken();
  await db
    .update(lists)
    .set({ editTokenHash: sha256Hex(next), updatedAt: new Date() })
    .where(eq(lists.id, row.id));
  return next;
}
