// Vault persistence: the capture upsert, the browse read, the autocomplete pool,
// and the tombstone. Ranking is NOT here — it lives in shared/vault.ts so the
// ordering is identical whichever engine is underneath, exactly as the catalog
// does it.

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { vaultFolders, vaultItems, vaults } from "../db/schema";
import type { useVaultDb } from "./db";
import {
  VAULT_CAPTURE_MAX,
  VAULT_NAME_MAX,
  VAULT_SHORT_MAX,
  VAULT_URL_MAX,
  vaultNormKey,
  type VaultCapture,
  type VaultEntry,
  type VaultFolder,
} from "../../shared/vault";
import type { Classification } from "../../shared/types";
import { itemDisplayName } from "../../shared/weights";
import { foldForSearch } from "../../shared/catalogSearch";
import { tidyText } from "../../shared/tidyText";
import { rankVaultRows } from "../../shared/vaultSearch";

type Db = Awaited<ReturnType<typeof useVaultDb>>;

/** Upper bound on the rows pulled into memory for a search or a browse. A vault is
 *  personal gear, so real ones are dozens of rows; this only bounds the pathological
 *  case, and the JS ranker over a few hundred rows is far cheaper than the round
 *  trip that fetched them. */
const POOL_LIMIT = 1000;

/** Ceiling on TOTAL rows (live + removed) one vault may hold. Twice POOL_LIMIT:
 *  the reads truncate at 1000 anyway, so rows past that are invisible to their
 *  own owner — the ceiling bounds junk, not use. Capture drops new keys over the
 *  cap rather than erroring; updates to existing rows always land. */
export const VAULT_ITEMS_MAX = 2000;

/** Ceiling on folders per vault, same spirit. Capture stops creating folders at
 *  the cap (items land unfiled); a deliberate add on /vault refuses quietly. */
export const VAULT_FOLDERS_MAX = 200;

const CLASSIFICATIONS: Classification[] = ["base", "worn", "consumable"];

type Row = typeof vaultItems.$inferSelect;

/** DB row → wire shape: SQL nulls become absent fields, so the client sees the same
 *  optional-property shape the capture side produces. */
// The vault's backfill, in the one place every read converts a row (the live list, the
// removed list and the autocomplete all land here). Rows captured before the tidy
// existed hold straight apostrophes and doubled spaces, and a vault row sits directly
// beside list rows that are tidied — in the autocomplete menu they are adjacent lines.
//
// Display only, and safe to be: identity is `normKey`, which folds through
// foldForSearch (non-alphanumerics stripped), so "Arc'teryx" and "Arc’teryx" produce
// the SAME key. Tidying what's shown cannot re-key a row, split one in two, or miss the
// upsert target. The stored column keeps whatever it had until the next capture
// rewrites it from an already-tidied list item.
function toEntry(row: Row): VaultEntry {
  return {
    id: row.id,
    normKey: row.normKey,
    brand: row.brand ? tidyText(row.brand) || undefined : undefined,
    name: tidyText(row.name),
    variant: row.variant ? tidyText(row.variant) || undefined : undefined,
    commonName: row.commonName ? tidyText(row.commonName) || undefined : undefined,
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

/** A string field off the wire: typed, capped, tidied — or dropped. The shipped
 *  client already sends clean values; this is for the direct POST that doesn't.
 *  tidyText rather than a bare trim, so a hand-rolled POST can't seed the vault with
 *  text the editor would never have stored (and toEntry would only re-tidy on read). */
function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  return tidyText(v.slice(0, max)) || undefined;
}

/** Re-derive the identity server-side rather than trusting the client's normKey —
 *  a forged key could otherwise collide two unrelated items into one row (or dodge
 *  a tombstone). Drops anything that doesn't survive normalization. Fields are
 *  rebuilt explicitly (no spread) so nothing rides in untyped or uncapped: the
 *  caps are the same ones captureFromList applies client-side, and the folder
 *  name takes the folder table's own cap — an oversized one used to blow the
 *  btree index limit and 500 the whole capture. */
function sanitize(caps: VaultCapture[]): VaultCapture[] {
  const out = new Map<string, VaultCapture>();
  for (const c of caps.slice(0, VAULT_CAPTURE_MAX)) {
    const name = str(c?.name, VAULT_NAME_MAX);
    if (!name) continue;
    const brand = str(c.brand, VAULT_SHORT_MAX);
    const variant = str(c.variant, VAULT_SHORT_MAX);
    const normKey = vaultNormKey(brand, name, variant);
    if (!normKey) continue;
    out.set(normKey, {
      normKey,
      name,
      brand,
      variant,
      commonName: str(c.commonName, VAULT_SHORT_MAX),
      productUrl: str(c.productUrl, VAULT_URL_MAX),
      folder: str(c.folder, FOLDER_NAME_MAX),
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
  let clean = sanitize(caps);
  if (!clean.length) return 0;

  // The per-vault ceiling. Updates to rows already in the vault always land —
  // they add nothing — but new keys stop at VAULT_ITEMS_MAX, silently: capture is
  // an automatic side effect of editing a list, so refusing loudly would put an
  // error in front of someone who didn't ask for anything. Counted lazily (one
  // cheap indexed count) and only disambiguated when the request could actually
  // cross the line.
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(vaultItems)
    .where(eq(vaultItems.vaultId, vaultId));
  const room = VAULT_ITEMS_MAX - Number(n);
  if (clean.length > room) {
    const existing = new Set(
      (
        await db
          .select({ k: vaultItems.normKey })
          .from(vaultItems)
          .where(
            and(
              eq(vaultItems.vaultId, vaultId),
              inArray(
                vaultItems.normKey,
                clean.map((c) => c.normKey),
              ),
            ),
          )
      ).map((r) => r.k),
    );
    let budget = Math.max(0, room);
    clean = clean.filter((c) => {
      if (existing.has(c.normKey)) return true;
      if (budget === 0) return false;
      budget--;
      return true;
    });
    if (!clean.length) return 0;
  }

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
  const have = await db
    .select({ id: vaultFolders.id, name: vaultFolders.name, sortOrder: vaultFolders.sortOrder })
    .from(vaultFolders)
    .where(eq(vaultFolders.vaultId, vaultId));
  const byName = new Map(have.map((r) => [r.name, r.id]));
  // Only names that need creating count against the folder ceiling — captures
  // naming existing folders are idempotent whatever the count. Past the cap the
  // extra folders simply aren't made and their items land unfiled, which keeps an
  // automatic path from erroring (a deliberate add on /vault refuses instead).
  const missing = wanted.filter((n) => !byName.has(n)).slice(0, Math.max(0, VAULT_FOLDERS_MAX - have.length));
  if (!missing.length) return byName;
  const max = have.reduce((m, r) => Math.max(m, r.sortOrder), 0);
  await db
    .insert(vaultFolders)
    .values(missing.map((name, i) => ({ vaultId, name, sortOrder: max + i + 1 })))
    .onConflictDoNothing({ target: [vaultFolders.vaultId, vaultFolders.name] });
  // re-read rather than trusting returning(): a racing capture may have created
  // some of `missing` first, in which case our insert skipped them
  const rows = await db
    .select({ id: vaultFolders.id, name: vaultFolders.name })
    .from(vaultFolders)
    .where(eq(vaultFolders.vaultId, vaultId));
  return new Map(rows.map((r) => [r.name, r.id]));
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
  // tidied on read like the items are (toEntry) — these names are copied from list
  // folder names, so an old one reads "Men's layers" beside a list showing "Men’s
  // layers". The stored name is the unique key here, so it is deliberately NOT
  // rewritten: only what the page renders changes.
  return rows.map((r) => ({
    id: r.id,
    name: tidyText(r.name),
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

// ---------------------------------------------------------------------------
// the nightly reaper
// ---------------------------------------------------------------------------
// Vaults are minted lazily and never signed out of, so without this they only ever
// accumulate: every abandoned device, every browser that captured once and never
// came back. `last_seen_at` is bumped by requireVault on EVERY vault request
// — capture included, which for anyone actively building lists is constant — so
// "not seen in months" is a strong signal and not a proxy for "quiet lately".
//
// Two stages, the shape lists already use (see listRepo): soft-delete first, hard
// delete only after a grace window. That matters more here than it does for a
// list: there is no account and no email behind a vault, so a hard reap would be
// unrecoverable for someone who kept the link in a note and came back late. Inside
// the grace, using the link is enough — requireVault clears deleted_at.

/** Untouched for this long and a vault is presumed abandoned. Much longer than a
 *  list's 30: a list is reaped for being EMPTY as well as stale, whereas a full
 *  vault is exactly what someone might return to after a season off. */
export const VAULT_REAP_STALE_DAYS = Math.max(1, Number(process.env.VAULT_REAP_STALE_DAYS) || 180);
/** How long a soft-deleted vault stays revivable — the same 90 days a list gets. */
export const VAULT_PURGE_GRACE_DAYS = Math.max(
  1,
  Number(process.env.VAULT_PURGE_GRACE_DAYS) || 90,
);
const VAULT_REAP_BATCH_MAX = 10_000;

function batchLimit(n: number | undefined): number {
  return Math.max(1, Math.min(VAULT_REAP_BATCH_MAX, Math.floor(n ?? 5_000)));
}

/** Soft-delete vaults not seen in `staleDays`. Batched, so one run can never issue
 *  an unbounded write — a backlog just drains over successive nights. */
export async function reapAbandonedVaults(
  db: Db,
  opts?: { staleDays?: number; limit?: number },
): Promise<{ vaultsReaped: number }> {
  const staleDays = Math.max(1, Math.floor(opts?.staleDays ?? VAULT_REAP_STALE_DAYS));
  const cutoff = new Date(Date.now() - staleDays * 86_400_000);
  const candidates = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(isNull(vaults.deletedAt), lt(vaults.lastSeenAt, cutoff)))
    .limit(batchLimit(opts?.limit));
  if (!candidates.length) return { vaultsReaped: 0 };

  // no-arg .returning() — the neon-http | PGlite union's only shared overload
  const done = await db
    .update(vaults)
    .set({ deletedAt: new Date() })
    .where(inArray(vaults.id, candidates.map((c) => c.id)))
    .returning();
  return { vaultsReaped: done.length };
}

/** Hard-delete vaults soft-deleted more than `graceDays` ago, with their gear and
 *  folders. This is the stage that actually reclaims the storage. */
export async function purgeDeletedVaults(
  db: Db,
  opts?: { graceDays?: number; limit?: number },
): Promise<{ vaultsPurged: number }> {
  const graceDays = Math.max(1, Math.floor(opts?.graceDays ?? VAULT_PURGE_GRACE_DAYS));
  const cutoff = new Date(Date.now() - graceDays * 86_400_000);
  const doomed = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(isNotNull(vaults.deletedAt), lt(vaults.deletedAt, cutoff)))
    .limit(batchLimit(opts?.limit));
  if (!doomed.length) return { vaultsPurged: 0 };
  const ids = doomed.map((r) => r.id);

  // children first — there's no DB-level FK here (same as lists → snapshots), so
  // the cascade is manual, and doing it in this order means a run that dies partway
  // leaves orphaned NOTHING: the vault row is the last thing to go.
  await db.delete(vaultItems).where(inArray(vaultItems.vaultId, ids));
  await db.delete(vaultFolders).where(inArray(vaultFolders.vaultId, ids));
  await db.delete(vaults).where(inArray(vaults.id, ids));
  return { vaultsPurged: ids.length };
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
      const [{ max, n } = { max: 0, n: 0 }] = await db
        .select({
          max: sql<number>`coalesce(max(${vaultFolders.sortOrder}), 0)`,
          n: sql<number>`count(*)`,
        })
        .from(vaultFolders)
        .where(eq(vaultFolders.vaultId, vaultId));
      // at the ceiling, refuse like the empty-name case — quietly false, the same
      // "nothing was made" the caller already handles
      if (Number(n) >= VAULT_FOLDERS_MAX) return false;
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
