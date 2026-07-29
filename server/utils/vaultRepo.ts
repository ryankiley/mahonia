// Vault persistence: the capture upsert, the browse read, the autocomplete pool,
// and the tombstone. Ranking is NOT here — it lives in shared/vault.ts so the
// ordering is identical whichever engine is underneath, exactly as the catalog
// does it.

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { vaultItems } from "../db/schema";
import type { useVaultDb } from "./db";
import {
  VAULT_CAPTURE_MAX,
  vaultNormKey,
  type VaultCapture,
  type VaultEntry,
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
        timesSeen: sql`${vaultItems.timesSeen} + 1`,
        lastUsedAt: now,
        updatedAt: now,
      },
    });
  return clean.length;
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

