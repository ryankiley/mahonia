// List repository — all DB access for lists. Capability-based: callers hold an
// edit token (write) or a share code (read); the internal numeric id never
// leaves this module.

import { createError } from "h3";
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
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
import { UNITS } from "../../shared/types";
import type { ListData, ListSnapshot, ListState, Totals, Unit } from "../../shared/types";
import { isLikelySpam } from "../../shared/discovery";
import { ensureSnapshotSchema, useDb } from "./db";
import { ensureCatalogSchema } from "./catalog";
import { randomEditToken, randomShareCode, randomSlug, sha256Hex } from "./tokens";
import { stageCandidates, type CandidateObservation } from "./candidates";

type Db = Awaited<ReturnType<typeof useDb>>;

// The denormalized weight-rollup columns, derived from a list's totals. Single-
// sourced so the create / mutate / restore writes all set the SAME set of columns
// — adding a rollup touches one place, not three (where they could drift).
function weightColumns(totals: Totals) {
  return {
    baseWeightMg: totals.baseMg,
    wornWeightMg: totals.wornMg,
    consumableWeightMg: totals.consumableMg,
    totalWeightMg: totals.totalMg,
    itemCount: totals.itemCount,
  };
}

// Normalize + cap inbound content through the SAME reducer helpers the mutate path
// uses, so the create/restore paths can never be a clamp-bypass into raw JSONB.
// Beyond the per-field clamps, this is the only write path that takes a WHOLE list
// at once, so the reducer's list-wide referential invariants (enforced per-op in
// ops.ts addItem/moveItem) must be re-applied in bulk here — otherwise a raw create
// POST can persist dangling refs that render nowhere yet still count in totals
// (invisible, UI-undeletable weight). Mirrors jsonToListImport's healing rules:
// unknown folderId → ungrouped, dangling/self parentId → top-level, one nesting
// level only, and a nested child always carries its parent's folderId.
function normalizeListData(raw?: Partial<ListData>): ListData {
  // duplicate ids: first occurrence wins (the reducer's addItem/addFolder rule)
  const folders: ListData["folders"] = [];
  const folderIds = new Set<string>();
  for (const f of (raw?.folders ?? []).slice(0, MAX_FOLDERS).map(normalizeFolder)) {
    if (folderIds.has(f.id)) continue;
    folderIds.add(f.id);
    folders.push(f);
  }
  const items: ListData["items"] = [];
  const byId = new Map<string, ListData["items"][number]>();
  for (const it of (raw?.items ?? []).slice(0, MAX_ITEMS).map(normalizeItem)) {
    if (byId.has(it.id)) continue;
    byId.set(it.id, it);
    items.push(it);
  }
  for (const it of items) {
    if (it.folderId && !folderIds.has(it.folderId)) it.folderId = null;
    if (it.parentId && (it.parentId === it.id || !byId.has(it.parentId))) it.parentId = null;
  }
  // enforce one level: children of a parent that is itself nested flatten to
  // top-level (the set is computed before the pass, so deeper chains fully unwind)
  const topLevel = new Set(items.filter((i) => i.parentId == null).map((i) => i.id));
  for (const it of items) if (it.parentId && !topLevel.has(it.parentId)) it.parentId = null;
  // a nested child rides in its parent's folder (the shared/types invariant the
  // reducer keeps on addItem/moveItem) — parents' folderIds are already healed above
  for (const it of items) if (it.parentId) it.folderId = byId.get(it.parentId)!.folderId;
  return { folders, items };
}

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
    // ISO string for the wire; the driver hands back a Date (neon/PGlite) or, in
    // some paths, an already-serialized string — normalize both.
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : row.updatedAt
          ? String(row.updatedAt)
          : undefined,
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
  // The catalog table self-ensures on its own endpoints, but THIS query can run
  // first on a fresh database (a copied list carries catalogItemId) — ensure here
  // or every list read 500s until some catalog endpoint happens to run (the exact
  // Neon-only latent bug db.ts's useCatalogDb exists to prevent). Memoized, and
  // catalog-link-free lists never reach it (the early-out above), so no steady-
  // state cost. Lives here (not in callers) to also cover caller-passed db handles.
  await ensureCatalogSchema(db);
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

// The "is this token holder allowed to touch this live, non-deleted list" lookup.
// Exported so discoveryRepo shares the exact same capability gate (no drift).
export async function findByEditToken(editToken: string, db?: Db): Promise<ListRow | null> {
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
 * Restore a list to one of its snapshots (edit-token-gated). The overwritten
 * pre-restore state is snapshotted ("before restore") so a restore is itself
 * undoable. Returns
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
  const data = normalizeListData(s);
  const totals = computeTotals(data);
  const title = (s.title ?? "Untitled list").slice(0, 200);
  const displayUnit: Unit = UNITS.includes(s.displayUnit as Unit) ? (s.displayUnit as Unit) : "g";
  // restore writes title/description like a mutate does, so it's the same link-spam
  // vector: publish clean, then restore a link-stuffed earlier snapshot. Re-check
  // here too (set-only, mirroring applyOpsByEditToken) so this path can't smuggle
  // spam meta onto an already-public list past the publish-time gate.
  const spammyMeta = isLikelySpam({ title, description: s.description ?? null });

  // CAS like the mutate path: re-read + version-guard so a concurrent edit can't
  // be silently lost — and snapshot the overwritten state, so that edit is itself
  // recoverable.
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await findByEditToken(editToken, d);
    if (!row) return null;
    const updated = await d
      .update(lists)
      .set({
        title,
        description: s.description ?? null,
        displayUnit,
        data,
        ...weightColumns(totals),
        ...(row.isPublic && spammyMeta ? { flagged: true } : {}),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(lists.id, row.id), eq(lists.version, row.version)))
      .returning();
    if (updated[0]) {
      // Capture AFTER the CAS succeeds (mirroring the mutate path): the version
      // guard proves the in-hand `row` is exactly the state just overwritten, so
      // the pre-restore state (including any mid-loop concurrent edit) stays
      // recoverable — while failed attempts insert nothing. Capturing per attempt
      // would let a contended retry storm prune the whole recovery window with
      // post-vandalism states, which is the one scenario snapshots exist for.
      await captureSnapshot(d, row, "before restore");
      return rowToSnapshot(updated[0]);
    }
    // version moved under us — retry against the latest
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
  description?: string;
  displayUnit?: Unit;
  data?: ListData;
}): Promise<{ editToken: string; snapshot: ListSnapshot }> {
  const db = await useDb();
  const editToken = randomEditToken();
  const editTokenHash = sha256Hex(editToken);
  const title = (init?.title ?? "Untitled list").slice(0, 200);
  const description = init?.description ? init.description.slice(0, 4000) : undefined;
  const data = normalizeListData(init?.data);
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
          description,
          displayUnit,
          data,
          ...weightColumns(totals),
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
 * Owner-initiated delete: soft-delete the list this edit token holds. Reuses the
 * reaper's `deletedAt` model, so the list drops out of every capability lookup
 * (edit/share/public/feed all go through `liveOnly`) the instant this runs, and
 * the nightly purge reclaims its storage + snapshots after the same grace window
 * (so a mistaken delete is admin-recoverable for `LIST_PURGE_GRACE_DAYS`). Returns
 * false if the token resolves to nothing (already deleted / never existed) → 404.
 */
export async function softDeleteByEditToken(editToken: string, db?: Db): Promise<boolean> {
  const d = db ?? (await useDb());
  const row = await findByEditToken(editToken, d);
  if (!row) return false;
  const now = new Date();
  await d.update(lists).set({ deletedAt: now, updatedAt: now }).where(eq(lists.id, row.id));
  return true;
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

    // The publish-time link-spam gate must survive publishing: a setMeta on an
    // already-public list re-runs it, or clean-at-publish + spam-stuffed-after
    // bypasses moderation entirely on the indexable /l page. Set-only (sticky,
    // like publishList's `row.flagged || decision.flagged`) and gated on batches
    // that actually touch title/description, so ordinary item edits can never
    // re-flag an admin-restored list.
    const touchesMeta = ops.some(
      (op) =>
        op.t === "setMeta" &&
        (typeof op.patch?.title === "string" || typeof op.patch?.description === "string"),
    );
    const reflag =
      row.isPublic &&
      touchesMeta &&
      isLikelySpam({ title: state.title, description: state.description });

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
        ...weightColumns(totals),
        version: row.version + 1,
        updatedAt: new Date(),
        ...(doSnapshot ? { lastSnapshotAt: new Date() } : {}),
        ...(reflag ? { flagged: true } : {}),
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

// ---- maintenance: reap near-empty abandoned lists -------------------------
// A pack list with 0 or 1 items isn't a real list — the editor won't even create a
// server row until a list has real content (useGearList.hasRealContent), so these
// are fully-emptied drafts or direct-API junk. Left alone they only accrete,
// padding the table and burning slug/share-code space. A nightly cron soft-deletes
// the stale ones.
//
// The CONTENT test is item count (<= 1): a real list (2+ items) is NEVER eligible,
// however old — staleness is NOT grounds to delete a real list (a finished list can
// sit untouched forever and must survive). Staleness (updated_at) is only a
// debounce so we don't reap a near-empty list that's being actively built right
// now. Publish status is deliberately NOT a factor. Soft-delete (deleted_at,
// mirroring the rest of the schema) drops the row from every live query, frees the
// slug/share_code/edit_token (the unique indexes are WHERE deleted_at IS NULL), and
// stays reversible.
export const LIST_REAP_STALE_DAYS = Math.max(1, Number(process.env.LIST_REAP_STALE_DAYS) || 30);
const REAP_BATCH_MAX = 10_000;

/**
 * Soft-delete near-empty abandoned lists (<= 1 item, untouched for `staleDays`).
 * Real lists (2+ items) are never eligible, however stale. Batched (`limit`) so one
 * run can never issue an unbounded delete — a backlog just drains over successive
 * nights. Returns how many were reaped.
 */
export async function reapAbandonedLists(
  db?: Db,
  opts?: { staleDays?: number; limit?: number },
): Promise<{ reaped: number }> {
  const d = db ?? (await useDb());
  const staleDays = Math.max(1, Math.floor(opts?.staleDays ?? LIST_REAP_STALE_DAYS));
  const limit = Math.max(1, Math.min(REAP_BATCH_MAX, Math.floor(opts?.limit ?? 5_000)));
  const cutoff = new Date(Date.now() - staleDays * 86_400_000);

  // Select the eligible ids first (bounded), then soft-delete them and count via
  // RETURNING — a reliable affected-row count across both the neon-http and PGlite
  // drivers. The jsonb_array_length guard is belt-and-suspenders: reap only rows
  // whose ACTUAL item array holds <= 1 item, so a drifted item_count rollup can't
  // cause a real (2+ item) list to be reaped.
  const candidates = await d
    .select({ id: lists.id })
    .from(lists)
    .where(
      and(
        eq(lists.status, "active"),
        isNull(lists.deletedAt),
        lte(lists.itemCount, 1),
        sql`jsonb_array_length(coalesce(${lists.data} -> 'items', '[]'::jsonb)) <= 1`,
        lt(lists.updatedAt, cutoff),
      ),
    )
    .limit(limit);
  if (!candidates.length) return { reaped: 0 };

  const ids = candidates.map((c) => c.id);
  const now = new Date();
  // no-arg .returning() — the neon-http | PGlite union's only shared overload
  // (same constraint discoveryRepo.reportList notes). We only need the row count.
  const reaped = await d
    .update(lists)
    .set({ deletedAt: now, updatedAt: now })
    .where(inArray(lists.id, ids))
    .returning();
  return { reaped: reaped.length };
}

// Second stage: HARD-delete rows that have sat soft-deleted past the grace window,
// so the storage is actually reclaimed (soft-delete alone only hides the row). The
// grace period (default 90 days) is the reversible window — long enough that a
// mistaken reap can be spotted and restored before it's gone for good. Applies to
// ANY soft-deleted list, not just reaped ones (a general purge keyed on deleted_at
// age). Cascades to each list's snapshots, which hold full-copy payloads and are
// the real storage weight; an empty reaped list rarely has any, but other
// soft-deleted lists can.
export const LIST_PURGE_GRACE_DAYS = Math.max(1, Number(process.env.LIST_PURGE_GRACE_DAYS) || 90);

/**
 * Permanently delete lists soft-deleted more than `graceDays` ago (+ their
 * snapshots). Batched (`limit`) like the reaper so one run can't issue an unbounded
 * delete. Returns how many list rows were purged.
 */
export async function purgeDeletedLists(
  db?: Db,
  opts?: { graceDays?: number; limit?: number },
): Promise<{ purged: number }> {
  const d = db ?? (await useDb());
  const graceDays = Math.max(1, Math.floor(opts?.graceDays ?? LIST_PURGE_GRACE_DAYS));
  const limit = Math.max(1, Math.min(REAP_BATCH_MAX, Math.floor(opts?.limit ?? 5_000)));
  const cutoff = new Date(Date.now() - graceDays * 86_400_000);

  const doomed = await d
    .select({ id: lists.id })
    .from(lists)
    .where(and(isNotNull(lists.deletedAt), lt(lists.deletedAt, cutoff)))
    .limit(limit);
  if (!doomed.length) return { purged: 0 };
  const ids = doomed.map((r) => r.id);

  // drop child snapshots first (no DB-level FK, so this is manual), then the rows
  await ensureSnapshotSchema(d);
  await d.delete(listSnapshots).where(inArray(listSnapshots.listId, ids));
  await d.delete(lists).where(inArray(lists.id, ids));
  return { purged: ids.length };
}

export async function rotateEditToken(editToken: string): Promise<string | null> {
  const db = await useDb();
  const next = randomEditToken();
  // One atomic UPDATE keyed on the OLD token (not find-by-token then update-by-id):
  // when two rotates race — owner vs leaked-token holder, or the owner's own two
  // tabs — the loser's WHERE matches nothing and it 404s, instead of a 200 carrying
  // a token that was already overwritten (a silent, permanent lockout: the token is
  // the only credential). `liveOnly` keeps the active/not-deleted gate.
  // no-arg .returning() — the neon-http | PGlite union's only shared overload.
  const updated = await db
    .update(lists)
    .set({ editTokenHash: sha256Hex(next), updatedAt: new Date() })
    .where(liveOnly(lists.editTokenHash, sha256Hex(editToken)))
    .returning();
  return updated[0] ? next : null;
}
