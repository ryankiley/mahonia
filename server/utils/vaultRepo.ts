// Vault persistence: the capture upsert, the browse read, the autocomplete pool,
// and the tombstone. Ranking is NOT here — it lives in shared/vault.ts so the
// ordering is identical whichever engine is underneath, exactly as the catalog
// does it.

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { vaultFolders, vaultItems, vaults } from "../db/schema";
import type { Db } from "./db";
import {
  VAULT_CAPTURE_MAX,
  VAULT_NAME_MAX,
  VAULT_SHORT_MAX,
  VAULT_URL_MAX,
  vaultNormKey,
  type VaultCapture,
  type VaultEntry,
  type VaultFolder,
  type VaultPinField,
} from "../../shared/vault";
import type { Classification } from "../../shared/types";
import { KCAL_MAX, UNIT_WEIGHT_MAX_MG } from "../../shared/ops";
import { tidyText } from "../../shared/tidyText";
import { rankVaultRows } from "../../shared/vaultSearch";

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

/** Pin token ↔ its column, in ONE table so the read (pinsOf), the write
 *  (cleanVaultPatch) and the release (unpin) cannot drift apart. */
const PIN_COLUMN = [
  ["name", "namePinned"],
  ["weight", "weightPinned"],
  ["commonName", "commonNamePinned"],
  ["classification", "classificationPinned"],
  ["kcal", "kcalPinned"],
  ["productUrl", "productUrlPinned"],
] as const satisfies readonly (readonly [VaultPinField, keyof Row])[];

/** Six booleans in, one small array out — absent when nothing is pinned, the same
 *  "SQL nulls become absent fields" shape the rest of toEntry produces. */
function pinsOf(row: Row): VaultPinField[] | undefined {
  const out = PIN_COLUMN.filter(([, col]) => row[col]).map(([token]) => token);
  return out.length ? out : undefined;
}

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
    kcal: row.kcal ?? undefined,
    catalogItemId: row.catalogItemId ?? undefined,
    productUrl: row.productUrl ?? undefined,
    folderId: row.folderId ?? undefined,
    pinned: pinsOf(row),
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

/** A URL off the wire: typed and capped, but NOT tidied. tidyText curls a
 *  letter-flanked apostrophe, and a path can legitimately carry one
 *  (…/mens-jacket vs …/men's-jacket) — curling it rewrites the address to a page
 *  that isn't there. shared/ops.ts exempts productUrl from cleanText for exactly
 *  this reason; str() below does not, so the gear was curling them. */
function url(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.trim().slice(0, VAULT_URL_MAX) || undefined;
}

/** A weight off the wire, clamped to the same ceiling the reducer applies to a list
 *  row (clampWeight in shared/ops). Flooring at zero was not enough: a direct POST
 *  of 1e19 reached the bigint column and errored the whole multi-row capture, so
 *  one hostile row took a whole list's gear down with it. */
const clampWeightMg = (n: number) => Math.max(0, Math.min(UNIT_WEIGHT_MAX_MG, Math.round(n)));

/** kcal off the wire: a positive whole number under the reducer's own ceiling, or
 *  absent — the same bounds shared/ops applies to a list row, so a direct POST
 *  can't store a value the editor could never have produced. */
function kcalOf(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const k = Math.round(v);
  return k > 0 ? Math.min(KCAL_MAX, k) : undefined;
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
      productUrl: url(c.productUrl),
      folder: str(c.folder, FOLDER_NAME_MAX),
      weightMg: Number.isFinite(c.weightMg) ? clampWeightMg(c.weightMg) : 0,
      classification: CLASSIFICATIONS.includes(c.classification as Classification)
        ? c.classification
        : undefined,
      kcal: kcalOf(c.kcal),
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
 *  • common name / classification / kcal / catalog link — coalesce: a capture
 *    that carries the field sets it, one that doesn't leaves what's there. These
 *    accumulate rather than flip-flop as the same gear appears in different lists.
 *  • removed_at — UNTOUCHED. Capture is automatic, so if it cleared the tombstone
 *    every list still holding the item would resurrect it and "remove" would mean
 *    nothing. Only an explicit restore (or re-add from /gear) clears it.
 *  • a PINNED field — untouched, whatever the rule above says. Correcting a field
 *    on /gear is a statement that your value is the truth about your own gear, and
 *    an automatic write must not argue with a deliberate one. times_seen and
 *    last_used_at still move: those are facts about USE, not about the gear.
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
  const room = VAULT_ITEMS_MAX - (await vaultItemCount(db, vaultId));
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
    .values(clean.map((c) => rowValues(c, vaultId, now, (c.folder && folderId.get(c.folder)) || null)))
    .onConflictDoUpdate({
      target: [vaultItems.vaultId, vaultItems.normKey],
      set: {
        // brand/name/variant move as ONE spelling: they fold to the same key either
        // way, so capture takes the incoming one — unless you've corrected it on
        // /gear, in which case yours is the truth and no list can talk over it.
        brand: keepIfPinned(vaultItems.namePinned, vaultItems.brand, sql`excluded.brand`),
        name: keepIfPinned(vaultItems.namePinned, vaultItems.name, sql`excluded.name`),
        variant: keepIfPinned(vaultItems.namePinned, vaultItems.variant, sql`excluded.variant`),
        commonName: keepIfPinned(
          vaultItems.commonNamePinned,
          vaultItems.commonName,
          sql`coalesce(excluded.common_name, ${vaultItems.commonName})`,
        ),
        // the zero-guard survives INSIDE the pin: a pinned weight is never touched,
        // and an unpinned one still refuses to be erased by a weightless capture
        weightMg: keepIfPinned(
          vaultItems.weightPinned,
          vaultItems.weightMg,
          sql`case when excluded.weight_mg > 0 then excluded.weight_mg else ${vaultItems.weightMg} end`,
        ),
        classification: keepIfPinned(
          vaultItems.classificationPinned,
          vaultItems.classification,
          sql`coalesce(excluded.classification, ${vaultItems.classification})`,
        ),
        kcal: keepIfPinned(
          vaultItems.kcalPinned,
          vaultItems.kcal,
          sql`coalesce(excluded.kcal, ${vaultItems.kcal})`,
        ),
        productUrl: keepIfPinned(
          vaultItems.productUrlPinned,
          vaultItems.productUrl,
          sql`coalesce(excluded.product_url, ${vaultItems.productUrl})`,
        ),
        // Not pinnable, and deliberately: both are already first-write-wins, so a
        // pin would say nothing the coalesce doesn't already say.
        catalogItemId: sql`coalesce(excluded.catalog_item_id, ${vaultItems.catalogItemId})`,
        // FIRST filing wins. Coalesce, not overwrite: the same gear sits in
        // "Shelter" in one list and "Big 3" in another, and a capture must not
        // reshuffle a vault you've already arranged. Moving it is a deliberate act
        // on /gear (the folders route's "move"), and it stays put afterwards.
        folderId: sql`coalesce(${vaultItems.folderId}, excluded.folder_id)`,
        // Usage, not content. A pinned row is still gear a list just reached for,
        // and the autocomplete ranks on exactly these two — so they are never
        // guarded, however much of the row you've corrected by hand.
        timesSeen: sql`${vaultItems.timesSeen} + 1`,
        lastUsedAt: now,
        updatedAt: now,
      },
    });
  return clean.length;
}

/** The INSERT half a captured row and a hand-added one share — every content
 *  column off a sanitized capture, plus the usage stamps a brand-new row starts
 *  with. The pins are NOT here: capture asserts none and an add asserts them
 *  all, which is the whole difference between the two (see addVaultItem). */
function rowValues(c: VaultCapture, vaultId: number, now: Date, folderId: number | null) {
  return {
    vaultId,
    normKey: c.normKey,
    brand: c.brand ?? null,
    name: c.name,
    variant: c.variant ?? null,
    commonName: c.commonName ?? null,
    weightMg: c.weightMg,
    classification: c.classification ?? null,
    kcal: c.kcal ?? null,
    catalogItemId: c.catalogItemId ?? null,
    productUrl: c.productUrl ?? null,
    folderId,
    timesSeen: 1,
    lastUsedAt: now,
    updatedAt: now,
  };
}

/** How many rows (live AND removed — tombstones hold a slot) a vault holds: the
 *  count both ceilings (capture's silent drop, add's refusal) are measured
 *  against. One cheap indexed count. */
async function vaultItemCount(db: Db, vaultId: number): Promise<number> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(vaultItems)
    .where(eq(vaultItems.vaultId, vaultId));
  return Number(n);
}

/** Is this folder id one of THIS vault's? A folderId from another vault would
 *  file gear under a heading its owner can never see, so both writes that take
 *  an id off the wire (add, move) verify it in scope before writing. */
async function ownsFolder(db: Db, vaultId: number, folderId: number): Promise<boolean> {
  const owner = await db
    .select({ id: vaultFolders.id })
    .from(vaultFolders)
    .where(and(eq(vaultFolders.id, folderId), eq(vaultFolders.vaultId, vaultId)));
  return owner.length > 0;
}

/** A vault's live rows, most-recently-used first, bounded to POOL_LIMIT — the
 *  one read behind both the /vault browse and the autocomplete's candidate pool
 *  (idx_vault_recent serves exactly this shape). */
function liveRows(db: Db, vaultId: number) {
  return db
    .select()
    .from(vaultItems)
    .where(liveIn(vaultId))
    .orderBy(desc(vaultItems.lastUsedAt))
    .limit(POOL_LIMIT);
}

/** "A live row of this vault" — the predicate, written once. The browse, the
 *  membership read and capture's landed-keys check all mean the same thing by it,
 *  and a fourth condition on what counts as live (an archive flag, a per-row
 *  visibility column) has to reach all of them or the membership set starts
 *  claiming rows /gear won't show. */
function liveIn(vaultId: number) {
  return and(eq(vaultItems.vaultId, vaultId), isNull(vaultItems.removedAt));
}

/**
 * Wrap a merge rule so a PINNED field keeps whatever the gear already holds.
 *
 * One helper rather than six hand-written CASEs, so a field cannot be made pinnable
 * with its guard accidentally left off — the same reason the folder verbs share one
 * scoped switch instead of six endpoints.
 */
function keepIfPinned(flag: PgColumn, keep: PgColumn, rule: SQL): SQL {
  return sql`case when ${flag} then ${keep} else ${rule} end`;
}

/**
 * Map the folder names in a capture to gear folder ids, creating the missing ones.
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
  return (await liveRows(db, vaultId)).map(toEntry);
}

/**
 * What a vault holds, as identity keys and the one number that can still be
 * pushed into a row — no spellings, no folders, no tombstones.
 *
 * The editor's question about a list row is a MEMBERSHIP one ("is this gear
 * already mine?"), not a browse, and answering it with listVaultItems would ship
 * a whole vault's worth of rows to a page that renders none of them. Two columns,
 * as tuples, and a Map is all the client builds from it.
 *
 * WHY THE WEIGHT COMES TOO. "My Gear has this gear" is not the whole question the
 * save button asks — it asks whether pressing it would DO anything, and on a row
 * whose weight you have just corrected it still would: capture takes the incoming
 * weight (see the upsert above). Membership alone made the button vanish the
 * moment a row was banked and never bring it back, so a corrected weight could
 * not be pushed from that list at all. A null weight means the row's weight is
 * PINNED — you fixed it by hand on /gear, capture is not allowed to argue with
 * it, and offering to save would be offering a no-op.
 *
 * Bounded and ordered exactly like liveRows, which is the browse's own window:
 * a key outside it would hide the button on a row the owner cannot see, remove
 * or restore on /gear — a state with no way out. Removed rows are excluded
 * because capture never resurrects a tombstone (see captureVaultItems), so gear
 * you put away is genuinely not in your vault.
 */
export async function listVaultKeys(db: Db, vaultId: number): Promise<[string, number | null][]> {
  const rows = await db
    .select({
      normKey: vaultItems.normKey,
      weightMg: vaultItems.weightMg,
      weightPinned: vaultItems.weightPinned,
    })
    .from(vaultItems)
    .where(liveIn(vaultId))
    .orderBy(desc(vaultItems.lastUsedAt))
    .limit(POOL_LIMIT);
  return rows.map((r) => [r.normKey, r.weightPinned ? null : r.weightMg]);
}

/**
 * Which of these keys the vault actually holds, LIVE.
 *
 * The capture endpoint's honest answer to "what did you store?". A 2xx from
 * capture is not that answer: the upsert deliberately leaves `removed_at` alone,
 * so a row you removed on /gear is written and stays put away, and new keys past
 * VAULT_ITEMS_MAX are dropped silently. The client folds these keys into the set
 * that decides whether a save button renders, so it has to be told what landed
 * rather than what it sent — otherwise the button disappears from gear the vault
 * refused, and the row's own covered guard makes pressing it again a no-op.
 */
export async function liveKeysAmong(
  db: Db,
  vaultId: number,
  normKeys: string[],
): Promise<string[]> {
  if (!normKeys.length) return [];
  const rows = await db
    .select({ normKey: vaultItems.normKey })
    .from(vaultItems)
    .where(and(liveIn(vaultId), inArray(vaultItems.normKey, normKeys.slice(0, VAULT_CAPTURE_MAX))));
  return rows.map((r) => r.normKey);
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
  const rows = await liveRows(db, vaultId);
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
const VAULT_REAP_STALE_DAYS = Math.max(1, Number(process.env.VAULT_REAP_STALE_DAYS) || 180);
/** How long a soft-deleted vault stays revivable — the same 90 days a list gets. */
const VAULT_PURGE_GRACE_DAYS = Math.max(
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

// ---------------------------------------------------------------------------
// the row verbs: add a piece of gear by hand, correct one in place
// ---------------------------------------------------------------------------

/** The two things you can do to a vault ROW from /gear — see
 *  server/api/vault/items.post.ts for why they share a route with each other but
 *  not with the folder verbs. */
export type VaultItemOp =
  | {
      t: "add";
      brand?: string;
      name: string;
      variant?: string;
      commonName?: string;
      /** Absent or 0 = not weighed yet, a normal state for gear you've just
       *  remembered you own. A zero pins nothing — see cleanVaultPatch. */
      weightMg?: number;
      classification?: Classification;
      kcal?: number;
      productUrl?: string;
      /** File it as you create it; null = unfiled. Verified in this gear's scope. */
      folderId?: number | null;
    }
  | {
      t: "edit";
      id: number;
      patch: VaultItemPatch;
      /** Release a pin, so a list can teach the field again. The only way back from
       *  a pin — without it one correction would freeze a field forever. Applied
       *  AFTER the patch's own pins, so `{ patch: { weightMg: 545 }, unpin:
       *  ["weight"] }` reads as "set it, but keep taking my lists' word for it". */
      unpin?: VaultPinField[];
    };

/**
 * A field ABSENT here is untouched; present, it is set AND pinned; null (or a
 * string that tidies to "") CLEARS it and pins the emptiness — otherwise deleting a
 * bogus product URL would be undone by the next capture's coalesce. The same
 * semantics cleanItemPatch gives a list row in shared/ops.
 *
 * No folderId: re-filing a row is the folders route's "move" verb, and a second copy
 * of a scoped write is a second chance to scope it wrong.
 */
interface VaultItemPatch {
  brand?: string | null;
  name?: string;
  variant?: string | null;
  commonName?: string | null;
  weightMg?: number;
  classification?: Classification | null;
  kcal?: number | null;
  productUrl?: string | null;
}

/** The pin flags a deliberate write asserts, returned in the SAME object as the
 *  values they protect — so a field structurally cannot be written without being
 *  pinned alongside it. */
type ItemWrite = Partial<typeof vaultItems.$inferInsert>;

/**
 * Turn a patch off the wire into a scoped SET, pinning every field it touches.
 *
 * Returns null when the patch would leave the row nameless: `name` is NOT NULL, and
 * the row's whole identity was folded out of it.
 */
function cleanVaultPatch(patch: unknown): ItemWrite | null {
  const p = (patch ?? {}) as Record<string, unknown>;
  const out: ItemWrite = {};

  // one pin for the three: the stored SPELLING is one decision (VAULT_PIN_FIELDS)
  let spelled = false;
  if (typeof p.name === "string") {
    const name = str(p.name, VAULT_NAME_MAX);
    if (!name) return null;
    out.name = name;
    spelled = true;
  }
  if (typeof p.brand === "string" || p.brand === null) {
    out.brand = str(p.brand, VAULT_SHORT_MAX) ?? null;
    spelled = true;
  }
  if (typeof p.variant === "string" || p.variant === null) {
    out.variant = str(p.variant, VAULT_SHORT_MAX) ?? null;
    spelled = true;
  }
  if (spelled) out.namePinned = true;

  if (typeof p.commonName === "string" || p.commonName === null) {
    out.commonName = str(p.commonName, VAULT_SHORT_MAX) ?? null;
    out.commonNamePinned = true;
  }
  if (typeof p.productUrl === "string" || p.productUrl === null) {
    out.productUrl = url(p.productUrl) ?? null;
    out.productUrlPinned = true;
  }
  if (typeof p.weightMg === "number" && Number.isFinite(p.weightMg)) {
    const mg = clampWeightMg(p.weightMg);
    out.weightMg = mg;
    // Zero is the gear's own sentinel for "not weighed yet", and the merge rule
    // already refuses to let one overwrite a real weight. Pinning a zero would lock
    // the row out of ever learning its weight from a list, so clearing UNPINS.
    out.weightPinned = mg > 0;
  }
  if ("classification" in p) {
    if (p.classification === null) {
      out.classification = null;
      out.classificationPinned = true;
    } else if (CLASSIFICATIONS.includes(p.classification as Classification)) {
      out.classification = p.classification as Classification;
      out.classificationPinned = true;
    }
    // anything else is ignored rather than stored: the CHECK would reject it, and a
    // 500 is the wrong answer to one bad field
  }
  if ("kcal" in p) {
    if (p.kcal === null) {
      out.kcal = null;
      out.kcalPinned = true;
    } else if (typeof p.kcal === "number" && Number.isFinite(p.kcal)) {
      out.kcal = kcalOf(p.kcal) ?? null; // ≤0 reads as "clear", like the reducer's
      out.kcalPinned = true;
    }
  }
  return out;
}

/**
 * Apply one row op, always scoped to the caller's gear.
 *
 * Same discipline as applyVaultFolderOp: every WHERE carries vaultId alongside the
 * id, so an id from another gear matches nothing rather than being checked and
 * rejected. Returns the row as the client should now see it, or null — and null is
 * deliberately the one answer for "not yours", "doesn't exist" and "wouldn't
 * validate", so the endpoint never confirms another gear's row is real.
 */
export async function applyVaultItemOp(
  db: Db,
  vaultId: number,
  op: VaultItemOp,
): Promise<{ item: VaultEntry } | { refused: "duplicate" | "full" } | null> {
  switch (op?.t) {
    case "add":
      return addVaultItem(db, vaultId, op);
    case "edit":
      return editVaultItem(db, vaultId, op);
    default:
      return null;
  }
}

/**
 * Add a piece of gear nobody's list has carried yet.
 *
 * Cannot route through captureVaultItems, and the difference is the point: capture
 * is an automatic side effect of editing a list, so it can never clear a field, can
 * never set a weight to zero, and must never lift a tombstone (every list still
 * holding the gear would resurrect it, and "remove" would mean nothing). Typing a
 * row in by hand is the opposite of all three — it is you saying so.
 */
async function addVaultItem(db: Db, vaultId: number, op: Extract<VaultItemOp, { t: "add" }>) {
  // Straight through capture's own sanitizer, so a hand-typed row is capped, tidied
  // and IDENTIFIED by exactly the rules a captured one is. One identity rule, not two.
  const [clean] = sanitize([
    { ...op, normKey: "", weightMg: op.weightMg ?? 0, folder: undefined } as VaultCapture,
  ]);
  if (!clean) return null;

  // folderId is an ID here, not a name — on /gear you pick a folder, you don't type
  // one — so it takes the same in-scope check the "move" op does. Filing gear under
  // a heading its owner can never see would be worse than not filing it at all.
  if (op.folderId != null) {
    if (!Number.isInteger(op.folderId)) return null;
    if (!(await ownsFolder(db, vaultId, op.folderId))) return null;
  }

  // The ceiling. Counted lazily and disambiguated only when this request could cross
  // the line, like capture — but a DELIBERATE add REFUSES where capture drops
  // silently, the same way applyVaultFolderOp's "add" does. Landing on a key the
  // gear already holds adds no row, so it's allowed at any count.
  if ((await vaultItemCount(db, vaultId)) >= VAULT_ITEMS_MAX) {
    const [prior] = await db
      .select({ id: vaultItems.id })
      .from(vaultItems)
      .where(and(eq(vaultItems.vaultId, vaultId), eq(vaultItems.normKey, clean.normKey)));
    if (!prior) return { refused: "full" as const };
  }

  const now = new Date();
  const done = await db
    .insert(vaultItems)
    .values({
      ...rowValues(clean, vaultId, now, op.folderId ?? null),
      // Typing it in is choosing it: every field you supplied is yours, and no list
      // may overwrite it. A zero weight pins nothing — see cleanVaultPatch.
      namePinned: true,
      weightPinned: clean.weightMg > 0,
      commonNamePinned: clean.commonName != null,
      classificationPinned: clean.classification != null,
      kcalPinned: clean.kcal != null,
      productUrlPinned: clean.productUrl != null,
    })
    .onConflictDoUpdate({
      target: [vaultItems.vaultId, vaultItems.normKey],
      // THE difference from capture, and the whole reason this can't route through
      // it: an explicit add LIFTS a tombstone. It also means a conflict with a LIVE
      // row updates nothing and returns nothing — which is how the caller below
      // tells "you already have this" from "welcome back". Re-adding gear you
      // already hold should say so, not silently rewrite the row you were looking at.
      setWhere: isNotNull(vaultItems.removedAt),
      set: {
        // An add is an EXPLICIT act, so what you typed wins outright — no pin check
        // (you ARE the pin) and no coalesce on the fields you actually filled in.
        brand: sql`excluded.brand`,
        name: sql`excluded.name`,
        variant: sql`excluded.variant`,
        commonName: sql`coalesce(excluded.common_name, ${vaultItems.commonName})`,
        weightMg: sql`case when excluded.weight_mg > 0 then excluded.weight_mg else ${vaultItems.weightMg} end`,
        classification: sql`coalesce(excluded.classification, ${vaultItems.classification})`,
        kcal: sql`coalesce(excluded.kcal, ${vaultItems.kcal})`,
        productUrl: sql`coalesce(excluded.product_url, ${vaultItems.productUrl})`,
        // You named a folder → it wins; you didn't → it stays filed where it was.
        // The REVERSE of capture's coalesce, deliberately: capture is automatic and
        // must not reshuffle a gear, whereas an add is you doing the filing.
        folderId: sql`coalesce(excluded.folder_id, ${vaultItems.folderId})`,
        // pins UNION — an add must never RELEASE one an earlier edit earned
        namePinned: sql`true`,
        weightPinned: sql`${vaultItems.weightPinned} or excluded.weight_pinned`,
        commonNamePinned: sql`${vaultItems.commonNamePinned} or excluded.common_name_pinned`,
        classificationPinned: sql`${vaultItems.classificationPinned} or excluded.classification_pinned`,
        kcalPinned: sql`${vaultItems.kcalPinned} or excluded.kcal_pinned`,
        productUrlPinned: sql`${vaultItems.productUrlPinned} or excluded.product_url_pinned`,
        removedAt: null,
        // surfaces at the top of /gear, which orders by last_used_at desc
        lastUsedAt: now,
        updatedAt: now,
        // times_seen is NOT bumped: it counts CAPTURES — it ranks the autocomplete
        // by how often a LIST reaches for the gear — and typing a row in isn't one.
      },
    })
    .returning();
  // no row back = the conflict was with a live row and setWhere declined it
  return done[0] ? { item: toEntry(done[0]) } : { refused: "duplicate" as const };
}

/**
 * Correct a row in place.
 *
 * NO conflict handling, and none is possible: an edit changes the stored SPELLING
 * and never re-derives norm_key, so it cannot collide with (vault_id, norm_key). The
 * key is the gear’s IDENTITY; the spelling is a separate axis the vault has always
 * treated as overwritable (see captureFingerprint in shared/vault.ts).
 *
 * Re-deriving would orphan the row from the list that feeds it — and because capture
 * runs automatically from every open editor, that list would recreate the row under
 * its old name within seconds, unprompted. Freezing the key fails only if you go and
 * edit the list too, which is a second deliberate act.
 */
async function editVaultItem(db: Db, vaultId: number, op: Extract<VaultItemOp, { t: "edit" }>) {
  if (!Number.isInteger(op.id)) return null;
  const set = cleanVaultPatch(op.patch);
  if (!set) return null;
  if (Array.isArray(op.unpin)) {
    for (const [token, col] of PIN_COLUMN) if (op.unpin.includes(token)) set[col] = false;
  }
  if (!Object.keys(set).length) return null;

  // removed_at is untouched: editing a row you can see in the "removed" disclosure
  // is not the same as asking for it back, and restore is its own verb.
  // last_used_at and times_seen are untouched too — they mean "a list used this",
  // and an edit is not a use. Two of /gear's sort orders read them.
  const done = await db
    .update(vaultItems)
    .set({ ...set, updatedAt: new Date() })
    // ownership is IN the where, not a check on the result — see removeVaultItem
    .where(and(eq(vaultItems.id, op.id), eq(vaultItems.vaultId, vaultId)))
    .returning();
  return done[0] ? { item: toEntry(done[0]) } : null;
}

/** The folder verbs /gear offers, as one small tagged union — see
 *  server/api/vault/folders.post.ts for why they share a route. */
export type VaultFolderOp =
  | { t: "add"; name: string }
  | { t: "rename"; id: number; name: string }
  | { t: "remove"; id: number }
  | { t: "reorder"; ids: number[] }
  /** null folderId = unfile it */
  | { t: "move"; itemId: number; folderId: number | null };

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
      if (op.folderId != null && !(await ownsFolder(db, vaultId, op.folderId))) return false;
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
