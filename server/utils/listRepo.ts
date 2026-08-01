// List repository — all DB access for lists. Capability-based: callers hold an
// edit token (write) or a share code (read); the internal numeric id never
// leaves this module.

import { createError } from "h3";
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import { listClaims, catalogItems, listSnapshots, lists, type ListRow, users } from "../db/schema";
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
import { displayHost, normalizeTrailLabel, normalizeTrailUrl, safeUrl } from "../../shared/trailLink";
import { ensureSnapshotSchema, ensureTrailFaviconSchema, useAccountDb, useDb } from "./db";
import { getFavicon, warmFavicon } from "./trailFavicon";
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

// trailFaviconDataUrl is NOT set here — it lives in a separate per-host table and is
// attached by attachTrailFavicon on the read paths. A snapshot without it is perfectly
// valid; the link just renders without a mark.
export function rowToSnapshot(row: ListRow): ListSnapshot {
  const data = (row.data ?? { folders: [], items: [] }) as ListData;
  return {
    shareCode: row.shareCode,
    slug: row.publicSlug,
    title: row.title,
    description: row.description ?? undefined,
    trailUrl: row.trailUrl ?? undefined,
    trailLabel: row.trailLabel ?? undefined,
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
  // every catalog-linked row, whatever its override flags: each flag gates its OWN fields
  // below (nameOverridden the brand/name/variant, commonNameOverridden the gear type), so
  // filtering on one of them here would freeze the other's field too — a renamed product
  // would keep the gear type it had at rename time forever, which is not what
  // shared/types.ts promises ("independent of name/nameOverridden").
  const ids = [
    ...new Set(
      snap.items
        .filter((i) => typeof i.catalogItemId === "number" && !(i.nameOverridden && i.commonNameOverridden))
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
      commonName: catalogItems.commonName,
    })
    .from(catalogItems)
    .where(and(inArray(catalogItems.id, ids), eq(catalogItems.status, "active")));
  if (!rows.length) return snap;
  const byId = new Map(rows.map((r) => [r.id, r]));
  snap.items = snap.items.map((it) => {
    if (it.catalogItemId == null) return it;
    const c = byId.get(it.catalogItemId);
    if (!c) return it;
    // each flag gates only its own fields: nameOverridden keeps the user's brand/name/
    // variant, commonNameOverridden keeps their gear type. A row can hold one and not the
    // other — a renamed product still tracks the catalog's gear type, and a row with a
    // hand-typed gear type still tracks the catalog's name.
    return {
      ...it,
      ...(it.nameOverridden
        ? {}
        : { brand: c.brand ?? undefined, name: c.name, variant: c.variant ?? undefined }),
      ...(it.commonNameOverridden ? {} : { commonName: c.commonName ?? undefined }),
    };
  });
  return snap;
}

/** Attach the trail site's favicon from the per-host cache, if we have one. Never
 *  throws and never blocks: an unknown host, a missing table on a fresh Neon deploy, or
 *  a known-bad icon all just mean the link renders without a mark. */
export async function attachTrailFavicon(db: Db, snap: ListSnapshot): Promise<ListSnapshot> {
  if (!snap.trailUrl) return snap;
  try {
    await ensureTrailFaviconSchema(db);
    const url = safeUrl(snap.trailUrl);
    const dataUrl = url ? await getFavicon(db, displayHost(url)) : null;
    if (dataUrl) snap.trailFaviconDataUrl = dataUrl;
  } catch {
    /* decoration — a read must never fail over a missing favicon */
  }
  return snap;
}

/** Everything a READ view needs on top of the raw row: catalog trickle-down plus the
 *  trail-link favicon. Single-sourced so the read paths can't drift apart.
 *
 *  Deliberately NOT used by the mutate path. The favicon is a data: URL of up to 64 KB
 *  (~87 KB base64), and applyOpsByEditToken returns on a 450 ms autosave debounce whose
 *  response the client adopts wholesale and mirrors into IndexedDB — so attaching it
 *  there re-shipped an immutable icon on every keystroke batch. The editor gets its icon
 *  once from getByEditToken, or from /api/trail-favicon while the list is still a draft.
 *
 *  The two lookups hit different tables and touch different fields, so they run
 *  concurrently rather than paying both latencies in series. */
export async function hydrateForRead(db: Db, snap: ListSnapshot): Promise<ListSnapshot> {
  await Promise.all([hydrateCatalogNames(db, snap), attachTrailFavicon(db, snap)]);
  return snap;
}

function rowToState(row: ListRow): ListState {
  const data = (row.data ?? { folders: [], items: [] }) as ListData;
  return {
    title: row.title,
    description: row.description ?? undefined,
    trailUrl: row.trailUrl ?? undefined,
    trailLabel: row.trailLabel ?? undefined,
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
    // The newest snapshot is the chain anchor (a full `base`). We insert the new
    // full base on top and demote the previous anchor to a reverse-delta against
    // it — so only the newest row is ever a full copy. Reconstruction folds
    // newest→target (see shared/snapshotDiff), and pruning only drops the oldest
    // deltas (the anchor is the newest, never pruned) — no rebasing needed.
    const newest = (
      await db
        .select()
        .from(listSnapshots)
        .where(eq(listSnapshots.listId, row.id))
        .orderBy(desc(listSnapshots.createdAt), desc(listSnapshots.id))
        .limit(1)
    )[0];
    // The delta is computed from the row we just READ, before either write — so
    // the insert below can never be mistaken for the anchor being demoted.
    const demote =
      newest && newest.kind === "base"
        ? {
            id: newest.id,
            snapshot: diffListState(cur, fullSnapToState(newest.snapshot as FullSnap)),
          }
        : null;
    // ORDER MATTERS, and it is the opposite of the obvious one. These are two
    // separate statements with no transaction around them (the neon-http driver
    // sends one HTTP request per statement), and the catch below deliberately
    // swallows failures so snapshotting can never break a write — which means a
    // half-applied capture is silent. So make the half-applied state the harmless
    // one: INSERT the new base first, then demote.
    //   insert-then-demote (this order): a failed demote leaves TWO bases. A base
    //     resets the fold in reconstructChainAt, so every index still reconstructs
    //     correctly — it just costs one extra full copy until pruning.
    //   demote-then-insert (the reverse): a failed insert leaves the list with NO
    //     base at all. reconstructChainAt returns null for a diff with no anchor,
    //     so every restore 404s — and it never heals: the next capture sees a
    //     "diff" newest, skips the demotion, and stacks a fresh base on an orphaned
    //     delta whose reverse-diff was computed against a state that no longer
    //     precedes it, silently reconstructing WRONG history from then on.
    await db.insert(listSnapshots).values({
      listId: row.id,
      kind: "base",
      snapshot: stateToFullSnap(cur),
      itemCount: cur.items.length,
      version: row.version,
      reason,
    });
    if (demote) {
      await db
        .update(listSnapshots)
        .set({ kind: "diff", snapshot: demote.snapshot })
        .where(eq(listSnapshots.id, demote.id));
    }
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
  const spammyMeta = isLikelySpam({
    title,
    description: s.description ?? null,
    trailLabel: s.trailLabel ?? null,
  });

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
        trailUrl: s.trailUrl ?? null,
        trailLabel: s.trailLabel ?? null,
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

/**
 * Resolve a list's maker to the name shown under its title on the read views.
 *
 * Only a display name the account CHOSE is ever surfaced — never the email, never
 * a fallback derived from it. An account with no display name stays anonymous,
 * which is the default and the setting most people will leave alone.
 *
 * Attached at read time rather than denormalized onto the row so that renaming
 * yourself renames you everywhere at once, including on lists made years ago.
 */
export async function attachAuthorName(
  db: Db,
  snap: ListSnapshot,
  authorUserId: number | null,
): Promise<ListSnapshot> {
  if (authorUserId == null) return snap;
  const rows = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, authorUserId))
    .limit(1);
  const name = rows[0]?.displayName?.trim();
  if (name) snap.authorName = name;
  return snap;
}

export async function getByShareCode(code: string): Promise<ListSnapshot | null> {
  const c = normShareCode(code);
  if (!c) return null;
  const db = await useDb();
  const rows = await db.select().from(lists).where(liveOnly(lists.shareCode, c)).limit(1);
  if (!rows[0]) return null;
  // the byline belongs to the READ views only — /s and /l, not the editor, where
  // you are the author and being told so is noise
  const snap = await hydrateForRead(db, rowToSnapshot(rows[0]));
  return attachAuthorName(db, snap, rows[0].authorUserId);
}

export async function getByEditToken(editToken: string): Promise<ListSnapshot | null> {
  const db = await useDb();
  const row = await findByEditToken(editToken, db);
  return row ? hydrateForRead(db, rowToSnapshot(row)) : null;
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
  trailUrl?: string;
  trailLabel?: string;
  data?: ListData;
  /** The signed-in maker, when there is one — stamped ONCE at creation, for the
   *  byline on the read views. Absent for the (still entirely normal) no-account
   *  case, and never re-pointed later: an edit link is shared, so "who else holds
   *  this" is a different question from "who wrote it". */
  authorUserId?: number;
}): Promise<{ editToken: string; snapshot: ListSnapshot }> {
  const db = await useDb();
  const editToken = randomEditToken();
  const editTokenHash = sha256Hex(editToken);
  // `|| `, not `??`: an unnamed draft now arrives with an EMPTY title (the editor shows
  // its ghosted placeholder instead of a literal), and a blank name would otherwise
  // produce a bare "-a1b2c3" slug and an empty row in "Your lists".
  const title = (init?.title?.trim() || "Untitled list").slice(0, 200);
  const description = init?.description ? init.description.slice(0, 4000) : undefined;
  // re-validated, not just clamped — a create can carry an imported JSON backup's URL
  const trailUrl = normalizeTrailUrl(init?.trailUrl) ?? undefined;
  const trailLabel = normalizeTrailLabel(init?.trailLabel);
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
          trailUrl,
          trailLabel,
          displayUnit,
          data,
          ...weightColumns(totals),
          authorUserId: init?.authorUserId ?? null,
          version: 1,
        })
        .returning();
      // same warm as the mutate path — a list created WITH a trail link (a saved draft,
      // or a JSON-backup import) must get its mark too, not wait for the nightly sweep
      warmFavicon(db, trailUrl);
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
    // trailLabel joins title/description here: it's owner-typed free text that renders
    // on /l. trailUrl doesn't — it's one validated URL in its own field, and counting
    // it would flag every list that legitimately uses the feature.
    const touchesMeta = ops.some(
      (op) =>
        op.t === "setMeta" &&
        (typeof op.patch?.title === "string" ||
          typeof op.patch?.description === "string" ||
          typeof op.patch?.trailLabel === "string"),
    );
    const reflag =
      row.isPublic &&
      touchesMeta &&
      isLikelySpam({
        title: state.title,
        description: state.description,
        trailLabel: state.trailLabel,
      });

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
        trailUrl: state.trailUrl ?? null,
        trailLabel: state.trailLabel ?? null,
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
      // Warm the trail site's favicon the first time we see its host, so the link
      // carries its mark straight away rather than waiting for the nightly sweep.
      // Only when the URL actually CHANGED in this batch — otherwise every item edit
      // on a list with a trail link would re-enter this (it early-outs on a cached
      // host, but that's still a query per save for no reason).
      // Deliberately not awaited: a slow third-party favicon must never hold up the
      // mutate response, and warmFavicon swallows its own failures.
      if (state.trailUrl !== row.trailUrl) warmFavicon(d, state.trailUrl);
      // catalog names only — see hydrateForRead on why the favicon stays off the write path
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

/**
 * Revoke the current edit token and issue a new one.
 *
 * ROTATION IS A REVOCATION, so it also drops the account claims on this list.
 * Without that, anyone who had claimed the list would keep full write access
 * through their session after the owner rotated to cut off a leaked link — the one
 * mechanism the product has for taking access back would silently not work against
 * exactly the people it exists to stop. See server/utils/claimRepo.ts for what a
 * claim is: a saved capability, which is why revoking the capability must revoke it.
 *
 * This is also what makes it safe to OFFER claiming at all. Opening an edit link
 * on a new device is indistinguishable, server-side, from being sent someone
 * else's — so claiming has to be a question the human answers, and a wrong answer
 * has to be undoable by the owner. This is that undo.
 *
 * Two claims survive, and only two:
 *  • `keepUserId` — whoever is doing the rotating. They're already being handed the
 *    new token, so dropping their claim would only lock them out of their own action.
 *  • the list's `author_user_id` — the person who made it. Otherwise a holder of a
 *    shared link could rotate and strip the creator's access, which is the reverse
 *    of what this endpoint is for.
 */
export async function rotateEditHash(
  editHash: string,
  keepUserId?: number,
  db?: Db,
): Promise<string | null> {
  // useAccountDb, not useDb: list_claims lives in the account schema, and on Neon
  // that's ensured on first use rather than migrated. Injectable like the other repo
  // functions here, so tests can drive a throwaway database.
  const d = db ?? (await useAccountDb());
  const next = randomEditToken();
  // One atomic UPDATE keyed on the OLD token (not find-by-token then update-by-id):
  // when two rotates race — owner vs leaked-token holder, or the owner's own two
  // tabs — the loser's WHERE matches nothing and it 404s, instead of a 200 carrying
  // a token that was already overwritten (a silent, permanent lockout: the token is
  // the only credential). `liveOnly` keeps the active/not-deleted gate.
  // no-arg .returning() — the neon-http | PGlite union's only shared overload.
  const updated = await d
    .update(lists)
    .set({ editTokenHash: sha256Hex(next), updatedAt: new Date() })
    .where(liveOnly(lists.editTokenHash, editHash))
    .returning();
  const row = updated[0];
  if (!row) return null;

  const spare = [keepUserId, row.authorUserId].filter((id): id is number => typeof id === "number");
  await d
    .delete(listClaims)
    .where(
      spare.length
        ? and(eq(listClaims.listId, row.id), notInArray(listClaims.userId, spare))
        : eq(listClaims.listId, row.id),
    );
  return next;
}

export async function rotateEditToken(editToken: string, keepUserId?: number): Promise<string | null> {
  return rotateEditHash(sha256Hex(editToken), keepUserId);
}
