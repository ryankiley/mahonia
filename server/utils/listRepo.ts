// List repository — all DB access for lists. Capability-based: callers hold an
// edit token (write) or a share code (read); the internal numeric id never
// leaves this module.

import { createError } from "h3";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { lists, listSnapshots, type ListRow } from "../db/schema";
import {
  applyOps,
  MAX_FOLDERS,
  MAX_ITEMS,
  normalizeFolder,
  normalizeItem,
  type Op,
} from "../../shared/ops";
import { computeTotals } from "../../shared/weights";
import type { ListData, ListSnapshot, ListState, Unit } from "../../shared/types";
import { ensureSnapshotSchema, useDb } from "./db";
import { randomEditToken, randomShareCode, randomSlug, sha256Hex } from "./tokens";

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
const SNAPSHOT_THROTTLE_MS = 5 * 60_000; // at most one auto-snapshot per list / 5 min
const SNAPSHOT_CAP = 20; // keep the most recent N per list (older are pruned)

/**
 * Insert a recovery point of `row`'s CURRENT state + prune to the cap. Best-effort
 * — NEVER throws (a snapshot failure must not break a write). The THROTTLE lives in
 * the caller (off the in-hand row's lastSnapshotAt) so the hot path needs no query.
 */
async function captureSnapshot(db: Db, row: ListRow, reason: string): Promise<void> {
  try {
    await ensureSnapshotSchema(db);
    await db.insert(listSnapshots).values({
      listId: row.id,
      snapshot: {
        title: row.title,
        description: row.description ?? null,
        displayUnit: row.displayUnit,
        data: (row.data ?? { folders: [], items: [] }) as ListData,
      },
      version: row.version,
      reason,
    });
    // prune beyond the cap (oldest first; id tie-breaks same-timestamp rows)
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
  const rows = await d
    .select()
    .from(listSnapshots)
    .where(eq(listSnapshots.listId, row.id))
    .orderBy(desc(listSnapshots.createdAt), desc(listSnapshots.id))
    .limit(SNAPSHOT_CAP);
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    reason: r.reason ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    itemCount: r.snapshot?.data?.items?.length ?? 0,
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
  const snaps = await d
    .select()
    .from(listSnapshots)
    .where(and(eq(listSnapshots.id, snapshotId), eq(listSnapshots.listId, owner.id)))
    .limit(1);
  const snap = snaps[0];
  if (!snap) return null; // unknown id, or not this caller's list

  const s = snap.snapshot;
  // re-normalize through the SAME reducer helpers (defensive — a snapshot must not
  // be a clamp-bypass back into raw JSONB), and re-validate the unit
  const data: ListData = {
    folders: (s.data?.folders ?? []).slice(0, MAX_FOLDERS).map(normalizeFolder),
    items: (s.data?.items ?? []).slice(0, MAX_ITEMS).map(normalizeItem),
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
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

export async function getByEditToken(editToken: string): Promise<ListSnapshot | null> {
  const row = await findByEditToken(editToken);
  return row ? rowToSnapshot(row) : null;
}

/** version of a list addressed by share code (cheap; for live-sync polling). */
export async function versionByShareCode(code: string): Promise<number | null> {
  const c = normShareCode(code);
  if (!c) return null;
  const db = await useDb();
  const rows = await db
    .select({ version: lists.version })
    .from(lists)
    .where(liveOnly(lists.shareCode, c))
    .limit(1);
  return rows[0]?.version ?? null;
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
      return rowToSnapshot(updated[0]);
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
