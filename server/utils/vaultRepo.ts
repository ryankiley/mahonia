// Vault persistence: the capture upsert, the browse read, the autocomplete pool,
// and the tombstone. Ranking is NOT here — it lives in shared/vault.ts so the
// ordering is identical whichever engine is underneath, exactly as the catalog
// does it.

import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { vaultFolders, vaultItems } from "../db/schema";
import type { useVaultDb } from "./db";
import {
  VAULT_CAPTURE_MAX,
  vaultNormKey,
  type VaultCapture,
  type VaultEntry,
  type VaultFolder,
} from "../../shared/vault";
import type { Classification } from "../../shared/types";
import { itemDisplayName } from "../../shared/weights";
import { foldForSearch } from "../../shared/catalogSearch";
import { rankVaultRows } from "../../shared/vaultSearch";

type Db = Awaited<ReturnType<typeof useVaultDb>>;

/** Upper bound on the rows pulled into memory for a search or a browse. A vault is
 *  personal gear, so real ones are dozens of rows; this only bounds the pathological
 *  case, and the JS ranker over a few hundred rows is far cheaper than the round
 *  trip that fetched them. */
const POOL_LIMIT = 1000;

const CLASSIFICATIONS: Classification[] = ["base", "worn", "consumable"];

type Row = typeof vaultItems.$inferSelect;

/** DB row → wire shape: SQL nulls become absent fields, so the client sees the same
 *  optional-property shape the capture side produces. */
function toEntry(row: Row): VaultEntry {
  return {
    id: row.id,
    normKey: row.normKey,
    brand: row.brand ?? undefined,
    name: row.name,
    variant: row.variant ?? undefined,
    commonName: row.commonName ?? undefined,
    weightMg: Number(row.weightMg),
    classification: CLASSIFICATIONS.includes(row.classification as Classification)
      ? (row.classification as Classification)
      : undefined,
    catalogItemId: row.catalogItemId ?? undefined,
    productUrl: row.productUrl ?? undefined,
    folderId: row.folderId ?? undefined,
    timesSeen: row.timesSeen,
    lastUsedAt: new Date(row.lastUsedAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/** Re-derive the identity server-side rather than trusting the client's normKey —
 *  a forged key could otherwise collide two unrelated items into one row (or dodge
 *  a tombstone). Drops anything that doesn't survive normalization. */
function sanitize(caps: VaultCapture[]): VaultCapture[] {
  const out = new Map<string, VaultCapture>();
  for (const c of caps.slice(0, VAULT_CAPTURE_MAX)) {
    if (typeof c?.name !== "string") continue;
    const normKey = vaultNormKey(c.brand, c.name, c.variant);
    if (!normKey) continue;
    out.set(normKey, {
      ...c,
      normKey,
      weightMg: Number.isFinite(c.weightMg) ? Math.max(0, Math.round(c.weightMg)) : 0,
      classification: CLASSIFICATIONS.includes(c.classification as Classification)
        ? c.classification
        : undefined,
      catalogItemId: Number.isInteger(c.catalogItemId) ? c.catalogItemId : undefined,
    });
  }
  return [...out.values()];
}

/**
 * Fold a list's gear into the user's vault.
 *
 * One INSERT ... ON CONFLICT per capture, and every field's merge rule is a
 * deliberate answer to "which copy is the truth?":
 *
 *  • name / brand / variant — take the incoming spelling. They fold to the same
 *    key either way, so this just lets a tidied-up capitalisation win.
 *  • weight — last write wins, EXCEPT that a zero never overwrites a real weight.
 *    Re-weighing your quilt in any list should update the vault; adding a catalog
 *    item whose weight you haven't filled in yet should not erase what you knew.
 *  • common name / classification / catalog link — coalesce: a capture that
 *    carries the field sets it, one that doesn't leaves what's there. These
 *    accumulate rather than flip-flop as the same gear appears in different lists.
 *  • removed_at — UNTOUCHED. Capture is automatic, so if it cleared the tombstone
 *    every list still holding the item would resurrect it and "remove" would mean
 *    nothing. Only an explicit restore (or re-add from /vault) clears it.
 *
 * Returns how many rows were written, for the caller's response.
 */
export async function captureVaultItems(
  db: Db,
  vaultId: number,
  caps: VaultCapture[],
): Promise<number> {
  const clean = sanitize(caps);
  if (!clean.length) return 0;
  const now = new Date();
  // ONE multi-row statement, not one per item. A 40-item list was 40 sequential
  // round trips, which on Neon's HTTP driver (no pipelining) is the difference
  // between a capture that's imperceptible and one that isn't — and the backfill
  // below folds a whole list's worth of gear in at once.
  //
  // Safe as a single statement precisely because sanitize() deduped by normKey:
  // Postgres rejects an ON CONFLICT DO UPDATE that would touch the same row twice
  // within one command, so the dedup isn't just tidiness, it's load-bearing.
  // Resolve the list-folder NAMES this capture carries to vault folder ids,
  // creating any that don't exist yet. One statement for the whole set;
  // onConflictDoNothing makes it idempotent, so a replayed capture (the offline
  // queue, a flaky connection) neither duplicates a folder nor errors.
  const folderId = await ensureFolders(db, vaultId, clean.map((c) => c.folder));

  await db
    .insert(vaultItems)
    .values(
      clean.map((c) => ({
        vaultId,
        normKey: c.normKey,
        brand: c.brand ?? null,
        name: c.name,
        variant: c.variant ?? null,
        commonName: c.commonName ?? null,
        weightMg: c.weightMg,
        classification: c.classification ?? null,
        catalogItemId: c.catalogItemId ?? null,
        productUrl: c.productUrl ?? null,
        folderId: (c.folder && folderId.get(c.folder)) || null,
        timesSeen: 1,
        lastUsedAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [vaultItems.vaultId, vaultItems.normKey],
      set: {
        brand: sql`excluded.brand`,
        name: sql`excluded.name`,
        variant: sql`excluded.variant`,
        commonName: sql`coalesce(excluded.common_name, ${vaultItems.commonName})`,
        weightMg: sql`case when excluded.weight_mg > 0 then excluded.weight_mg else ${vaultItems.weightMg} end`,
        classification: sql`coalesce(excluded.classification, ${vaultItems.classification})`,
        catalogItemId: sql`coalesce(excluded.catalog_item_id, ${vaultItems.catalogItemId})`,
        productUrl: sql`coalesce(excluded.product_url, ${vaultItems.productUrl})`,
        // FIRST filing wins. Coalesce, not overwrite: the same gear sits in
        // "Shelter" in one list and "Big 3" in another, and a capture must not
        // reshuffle a vault you've already arranged. Moving it is a deliberate act
        // on /vault, and it stays put afterwards.
        folderId: sql`coalesce(${vaultItems.folderId}, excluded.folder_id)`,
        timesSeen: sql`${vaultItems.timesSeen} + 1`,
        lastUsedAt: now,
        updatedAt: now,
      },
    });
  return clean.length;
}

/**
 * Map the folder names in a capture to vault folder ids, creating the missing ones.
 * New folders land after the existing ones, in the order the names first appear.
 */
async function ensureFolders(
  db: Db,
  vaultId: number,
  names: (string | undefined)[],
): Promise<Map<string, number>> {
  const wanted = [...new Set(names.filter((n): n is string => !!n))];
  if (!wanted.length) return new Map();
  const [{ max } = { max: 0 }] = await db
    .select({ max: sql<number>`coalesce(max(${vaultFolders.sortOrder}), 0)` })
    .from(vaultFolders)
    .where(eq(vaultFolders.vaultId, vaultId));
  await db
    .insert(vaultFolders)
    .values(wanted.map((name, i) => ({ vaultId, name, sortOrder: Number(max) + i + 1 })))
    .onConflictDoNothing({ target: [vaultFolders.vaultId, vaultFolders.name] });
  const rows = await db
    .select({ id: vaultFolders.id, name: vaultFolders.name })
    .from(vaultFolders)
    .where(eq(vaultFolders.vaultId, vaultId));
  return new Map(rows.map((r) => [r.name, r.id]));
}

/**
 * Fold one vault's gear into another, and report how many pieces came across.
 *
 * This is what a transfer link runs before it swaps a device over. Without it,
 * opening the link on a device that had already been collecting gear pointed the
 * browser at the OTHER vault and left its own behind — still on disk, but with no
 * link to it and nothing in the UI that mentioned it. The gear was, for all
 * practical purposes, gone. A vault you can lose by using the feature meant to
 * spread it across your devices is the wrong shape.
 *
 * DIRECTION is source → destination, where the destination is the vault whose link
 * you just opened. That's the one you named as yours, and it may already be shared
 * with other devices; the local one is the stray. So every device you transfer to
 * converges on a single vault, rather than each swap picking a new winner.
 *
 * THE MERGE RULES ARE CAPTURE'S — deliberately. "Which copy is the truth?" was
 * already answered field by field in captureVaultItems, and a second set of answers
 * here would be a second thing to keep right. Three consequences worth naming:
 *
 *  • A tombstone in the DESTINATION survives. Gear you removed there stays removed
 *    even if the source still has it live — the same rule that stops every list
 *    holding an item from resurrecting it.
 *  • Tombstones in the SOURCE are simply not carried (live rows only). Bringing them
 *    across as live would resurrect what you removed; bringing them as tombstones
 *    would suppress gear the destination has live. Neither is what you asked for.
 *  • `times_seen` increments rather than summing, so a merged row reads as seen once
 *    more instead of the true total. It ranks the autocomplete and nothing else, and
 *    a bespoke statement to fix it would cost the reuse this function is built on.
 *
 * Idempotent: the identity index is (vault_id, norm_key), so adopting the same link
 * twice merges the same rows onto themselves.
 */
export async function mergeVaults(
  db: Db,
  destVaultId: number,
  sourceVaultId: number,
): Promise<number> {
  if (destVaultId === sourceVaultId) return 0;
  // Folders FIRST, and all of them — including any holding no gear. Capture only
  // ever creates the folders its own rows name, so leaving this to the item pass
  // would quietly drop a heading you'd made but not filled yet. Ensured in the
  // source's own order, so the arrangement arrives looking like the one you left.
  const sourceFolders = await db
    .select({ name: vaultFolders.name })
    .from(vaultFolders)
    .where(eq(vaultFolders.vaultId, sourceVaultId))
    .orderBy(asc(vaultFolders.sortOrder), asc(vaultFolders.id));
  await ensureFolders(db, destVaultId, sourceFolders.map((f) => f.name));

  // the folder NAME, not its id: ids are per-vault, and capture already resolves a
  // name to a folder in the destination (creating it if needed), so filing survives
  // the move for free
  const rows = await db
    .select({ item: vaultItems, folderName: vaultFolders.name })
    .from(vaultItems)
    .leftJoin(vaultFolders, eq(vaultItems.folderId, vaultFolders.id))
    .where(and(eq(vaultItems.vaultId, sourceVaultId), isNull(vaultItems.removedAt)))
    .orderBy(desc(vaultItems.lastUsedAt))
    .limit(POOL_LIMIT);
  if (!rows.length) return 0;

  const caps: VaultCapture[] = rows.map(({ item, folderName }) => ({
    normKey: item.normKey, // re-derived by sanitize() regardless
    brand: item.brand ?? undefined,
    name: item.name,
    variant: item.variant ?? undefined,
    commonName: item.commonName ?? undefined,
    weightMg: Number(item.weightMg),
    classification: CLASSIFICATIONS.includes(item.classification as Classification)
      ? (item.classification as Classification)
      : undefined,
    catalogItemId: item.catalogItemId ?? undefined,
    productUrl: item.productUrl ?? undefined,
    folder: folderName ?? undefined,
  }));

  // POOL_LIMIT (1000) is above VAULT_CAPTURE_MAX (200), and sanitize() TRUNCATES at
  // the cap rather than erroring — so a big vault merged in one call would lose the
  // tail silently. Chunked, because losing gear is the exact failure this function
  // exists to prevent.
  let merged = 0;
  for (let i = 0; i < caps.length; i += VAULT_CAPTURE_MAX)
    merged += await captureVaultItems(db, destVaultId, caps.slice(i, i + VAULT_CAPTURE_MAX));
  return merged;
}

/** Every live row in a user's vault, most-recently-used first — the /vault page's
 *  read. Small by nature, so it's one unpaginated query. */
export async function listVaultItems(db: Db, vaultId: number): Promise<VaultEntry[]> {
  const rows = await db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.vaultId, vaultId), isNull(vaultItems.removedAt)))
    .orderBy(desc(vaultItems.lastUsedAt))
    .limit(POOL_LIMIT);
  return rows.map(toEntry);
}

/** A vault's folders in drag order (id breaks a tie, so the order is total). */
export async function listVaultFolders(db: Db, vaultId: number): Promise<VaultFolder[]> {
  const rows = await db
    .select()
    .from(vaultFolders)
    .where(eq(vaultFolders.vaultId, vaultId))
    .orderBy(asc(vaultFolders.sortOrder), asc(vaultFolders.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sortBy: (r.sortBy as VaultFolder["sortBy"]) ?? undefined,
  }));
}

/**
 * The tombstoned rows — what "Remove" put away, most recently removed first.
 *
 * They need somewhere to be seen. Capture deliberately never clears a tombstone
 * (see captureVaultItems), which is what stops every list still holding the gear
 * from resurrecting it — but it also means removal is otherwise PERMANENT, with
 * nothing but the undo toast's few seconds to take it back. This is the way back:
 * one deliberate click, rather than the vault trying to guess from a capture
 * whether you meant to re-add something.
 */
export async function listRemovedVaultItems(db: Db, vaultId: number): Promise<VaultEntry[]> {
  const rows = await db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.vaultId, vaultId), isNotNull(vaultItems.removedAt)))
    .orderBy(desc(vaultItems.updatedAt))
    .limit(POOL_LIMIT);
  return rows.map(toEntry);
}

/** Rank a user's vault against an autocomplete query. Recall is the whole (bounded)
 *  live set; the fine ranking is the shared JS cascade — the catalog's PGlite
 *  strategy, applied here on both engines because a vault is always small. */
export async function searchVaultItems(db: Db, vaultId: number, q: string): Promise<VaultEntry[]> {
  if ((q ?? "").trim().length < 2) return [];
  const rows = await db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.vaultId, vaultId), isNull(vaultItems.removedAt)))
    .orderBy(desc(vaultItems.lastUsedAt))
    .limit(POOL_LIMIT);
  // rank the ROWS, then convert the handful that survive — toEntry allocates two
  // Dates and two ISO strings per row, and the ranker reads neither
  return rankVaultRows(rows, q).map(toEntry);
}

/**
 * Tombstone a row: stop offering it, keep the record so automatic capture can't
 * bring it back. Scoped by vaultId as well as id, so an id from another vault
 * simply matches nothing (no existence oracle, no 403). Returns whether a live row
 * was actually removed.
 */
export async function removeVaultItem(db: Db, vaultId: number, id: number): Promise<boolean> {
  const done = await db
    .update(vaultItems)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(vaultItems.id, id), eq(vaultItems.vaultId, vaultId), isNull(vaultItems.removedAt)),
    )
    // no-arg .returning() — the neon-http | PGlite union's only shared overload
    .returning();
  return done.length > 0;
}

/** Lift a tombstone — the undo behind the remove action. Ownership is part of the
 *  WHERE, not a check on the result: filtering afterwards would already have
 *  written to another account's row. */
export async function restoreVaultItem(db: Db, vaultId: number, id: number): Promise<boolean> {
  const done = await db
    .update(vaultItems)
    .set({ removedAt: null, updatedAt: new Date() })
    .where(and(eq(vaultItems.id, id), eq(vaultItems.vaultId, vaultId)))
    // no-arg .returning() — the neon-http | PGlite union's only shared overload
    .returning();
  return done.length > 0;
}

/** The folder verbs /vault offers, as one small tagged union — see
 *  server/api/vault/folders.post.ts for why they share a route. */
export type VaultFolderOp =
  | { t: "add"; name: string }
  | { t: "rename"; id: number; name: string }
  | { t: "remove"; id: number }
  | { t: "sort"; id: number; sortBy: string | null }
  | { t: "reorder"; ids: number[] }
  /** null folderId = unfile it */
  | { t: "move"; itemId: number; folderId: number | null };

const FOLDER_SORTS = new Set(["manual", "name", "heaviest", "lightest"]);
const FOLDER_NAME_MAX = 120;

/**
 * Apply one folder op, always scoped to the caller's vault.
 *
 * Every WHERE carries vaultId alongside the id, so an id from another vault
 * matches nothing rather than being checked and rejected — no existence oracle,
 * and no path where a missing scope leaks a row.
 */
export async function applyVaultFolderOp(
  db: Db,
  vaultId: number,
  op: VaultFolderOp,
): Promise<boolean> {
  switch (op.t) {
    case "add": {
      const name = (op.name ?? "").trim().slice(0, FOLDER_NAME_MAX);
      if (!name) return false;
      const [{ max } = { max: 0 }] = await db
        .select({ max: sql<number>`coalesce(max(${vaultFolders.sortOrder}), 0)` })
        .from(vaultFolders)
        .where(eq(vaultFolders.vaultId, vaultId));
      // a name that already exists is a no-op, not an error — the folder you asked
      // for is there either way
      const done = await db
        .insert(vaultFolders)
        .values({ vaultId, name, sortOrder: Number(max) + 1 })
        .onConflictDoNothing({ target: [vaultFolders.vaultId, vaultFolders.name] })
        .returning();
      return done.length > 0;
    }
    case "rename": {
      const name = (op.name ?? "").trim().slice(0, FOLDER_NAME_MAX);
      if (!name) return false;
      const done = await db
        .update(vaultFolders)
        .set({ name })
        .where(and(eq(vaultFolders.id, op.id), eq(vaultFolders.vaultId, vaultId)))
        .returning();
      return done.length > 0;
    }
    case "remove": {
      // The GEAR survives — deleting a folder unfiles what was in it rather than
      // taking it with it. A folder is a label here, not a container, and losing
      // gear because you tidied a heading would be indefensible.
      await db
        .update(vaultItems)
        .set({ folderId: null, updatedAt: new Date() })
        .where(and(eq(vaultItems.folderId, op.id), eq(vaultItems.vaultId, vaultId)));
      const done = await db
        .delete(vaultFolders)
        .where(and(eq(vaultFolders.id, op.id), eq(vaultFolders.vaultId, vaultId)))
        .returning();
      return done.length > 0;
    }
    case "sort": {
      const sortBy = op.sortBy && FOLDER_SORTS.has(op.sortBy) ? op.sortBy : null;
      const done = await db
        .update(vaultFolders)
        .set({ sortBy })
        .where(and(eq(vaultFolders.id, op.id), eq(vaultFolders.vaultId, vaultId)))
        .returning();
      return done.length > 0;
    }
    case "reorder": {
      const ids = (op.ids ?? []).filter((n) => Number.isInteger(n)).slice(0, 200);
      if (!ids.length) return false;
      // sequential rather than one CASE statement: a vault has a handful of
      // folders, and the readable version is worth more than the round trips here
      for (const [i, id] of ids.entries()) {
        await db
          .update(vaultFolders)
          .set({ sortOrder: i + 1 })
          .where(and(eq(vaultFolders.id, id), eq(vaultFolders.vaultId, vaultId)));
      }
      return true;
    }
    case "move": {
      if (!Number.isInteger(op.itemId)) return false;
      // a folderId from another vault would file gear under a heading you can't
      // see, so it's verified in the same scope before being written
      if (op.folderId != null) {
        const owner = await db
          .select({ id: vaultFolders.id })
          .from(vaultFolders)
          .where(and(eq(vaultFolders.id, op.folderId), eq(vaultFolders.vaultId, vaultId)));
        if (!owner.length) return false;
      }
      const done = await db
        .update(vaultItems)
        .set({ folderId: op.folderId ?? null, updatedAt: new Date() })
        .where(and(eq(vaultItems.id, op.itemId), eq(vaultItems.vaultId, vaultId)))
        .returning();
      return done.length > 0;
    }
    default:
      return false;
  }
}
