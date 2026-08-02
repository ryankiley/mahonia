// Claimed lists: the bridge between the capability model (a list belongs to
// whoever holds its edit link) and accounts (a list should still be there when you
// pick up a different device).
//
// A claim adds a SECOND way to prove the same capability. It never replaces the
// first: the edit link keeps working exactly as before, for claimers and
// non-claimers alike, and claiming a list takes nothing away from anyone else
// holding that link.

import { and, desc, eq, isNull } from "drizzle-orm";
import { listClaims, lists } from "../db/schema";
import type { useAccountDb } from "./db";
import { findByEditToken, normShareCode } from "./listRepo";
import { captureVaultItems } from "./vaultRepo";
import { mintVault, touchVaultByUser } from "./vaultAuth";
import { VAULT_CAPTURE_MAX, captureFromList, type VaultCapture } from "../../shared/vault";
import type { Unit } from "../../shared/types";

type Db = Awaited<ReturnType<typeof useAccountDb>>;

/** Cap on how many tokens one claim request may carry. "Your lists" is a device
 *  registry a person built by hand; anything past this is not a real browser. */
export const CLAIM_BATCH_MAX = 200;

/** Ceiling on a single backfill. A personal gear collection is dozens of items;
 *  this only bounds the pathological account. */
export const VAULT_BACKFILL_MAX = 1000;

/** A claimed list as the client needs it to render "Your lists" and open one. */
export interface ClaimedList {
  shareCode: string;
  slug: string;
  title: string;
  totalMg: number;
  version: number;
  displayUnit: Unit;
  updatedAt: string;
}

/**
 * Claim every list the caller can prove they hold, by presenting its edit token.
 *
 * The tokens are used and dropped — resolved to a list id, never stored. What
 * persists is (user, list), which is why a database dump still contains no write
 * capability for anyone's list.
 *
 * Unresolvable tokens are skipped in silence rather than reported: a device
 * registry accumulates dead entries (deleted lists, rotated links), and a
 * per-token verdict would let a caller test arbitrary tokens for existence.
 * Returns the number newly claimed.
 */
export async function claimLists(db: Db, userId: number, editTokens: string[]): Promise<number> {
  const tokens = editTokens
    .filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 200)
    .slice(0, CLAIM_BATCH_MAX);
  if (!tokens.length) return 0;

  let claimed = 0;
  for (const token of tokens) {
    const row = await findByEditToken(token, db as never);
    if (!row) continue;
    const done = await db
      .insert(listClaims)
      .values({ userId, listId: row.id })
      .onConflictDoNothing({ target: [listClaims.userId, listClaims.listId] })
      // no-arg .returning() — the neon-http | PGlite union's only shared overload
      .returning();
    if (done.length) claimed++;
  }
  return claimed;
}

/**
 * The lists this account holds, newest-edited first.
 *
 * Joins through to the live list rows, so a list deleted (by anyone holding its
 * link) simply stops appearing — the claim row is harmless and the nightly purge
 * takes the list itself.
 *
 * Returns the SHARE CODE as the handle, never the edit token: the client opens a
 * claimed list by naming it and proving the session, not by being handed back a
 * capability. The share code is already public (it's the /s/ read link), so it
 * carries nothing new.
 */
export async function listClaimedLists(db: Db, userId: number): Promise<ClaimedList[]> {
  const rows = await db
    .select({
      shareCode: lists.shareCode,
      slug: lists.publicSlug,
      title: lists.title,
      totalWeightMg: lists.totalWeightMg,
      version: lists.version,
      displayUnit: lists.displayUnit,
      updatedAt: lists.updatedAt,
    })
    .from(listClaims)
    .innerJoin(lists, eq(lists.id, listClaims.listId))
    .where(
      and(
        eq(listClaims.userId, userId),
        eq(lists.status, "active"),
        isNull(lists.deletedAt),
      ),
    )
    .orderBy(desc(lists.updatedAt))
    .limit(CLAIM_BATCH_MAX);

  return rows.map((r) => ({
    shareCode: r.shareCode,
    slug: r.slug,
    title: r.title,
    totalMg: Number(r.totalWeightMg),
    version: r.version,
    displayUnit: (["g", "kg", "oz", "lb"] as const).includes(r.displayUnit as Unit)
      ? (r.displayUnit as Unit)
      : "g",
    updatedAt: new Date(r.updatedAt).toISOString(),
  }));
}

/**
 * Fold the gear from EVERY list this account holds into its vault.
 *
 * Capture normally happens as you edit or open a list, which leaves a real gap:
 * lists you built before you ever signed in, and lists you simply haven't opened
 * on this account, never contribute. So "everything I own" wasn't quite that.
 * Claims close it — the server knows which lists are yours, and each row already
 * carries its full content, so the whole vault can be rebuilt from them without
 * the user opening anything.
 *
 * Runs on sign-in (see /api/lists/claim). Idempotent by construction: the capture
 * upsert merges rather than duplicating, and it leaves tombstones alone, so gear
 * you deliberately removed is NOT dragged back by a later backfill.
 *
 * Deduped across every list before the write, so this is a bounded set (one row
 * per distinct piece of gear you own) and a handful of statements, not one per
 * list — which is what makes it cheap enough to do on every sign-in.
 */
export async function backfillVaultFromClaims(db: Db, userId: number): Promise<number> {
  const rows = await db
    .select({ data: lists.data })
    .from(listClaims)
    .innerJoin(lists, eq(lists.id, listClaims.listId))
    .where(
      and(eq(listClaims.userId, userId), eq(lists.status, "active"), isNull(lists.deletedAt)),
    )
    .limit(CLAIM_BATCH_MAX);

  const byKey = new Map<string, VaultCapture>();
  for (const row of rows) {
    const items = Array.isArray(row.data?.items) ? row.data.items : [];
    // most-recently-updated list wins on a conflict, since rows come back in that
    // order and a later set() overwrites — the same "your newest weight is your
    // truth" rule the upsert itself follows
    for (const cap of captureFromList(items)) if (!byKey.has(cap.normKey)) byKey.set(cap.normKey, cap);
  }
  if (!byKey.size) return 0;

  // Resolve the ACCOUNT to its VAULT before writing anything.
  //
  // This is the whole reason the resolution happens in here rather than at the call
  // site: captureVaultItems takes a vaultId, this function is handed a userId, and
  // both are plain `number`. Passing the wrong one compiles, and `vault_items` has
  // no foreign key on `vault_id` — so the rows land in whatever vault happens to
  // share that id, which is somebody else's. A caller cannot make that mistake if
  // it never gets to choose.
  //
  // Mints on demand: signing in on a new device is exactly when someone has claims
  // but no vault row yet, and that is the case this function exists to serve.
  const vaultId = (await touchVaultByUser(db, userId)) ?? (await mintVault(db, userId));

  // chunked to the per-call cap so a large collection isn't silently truncated by
  // the sanitizer's slice
  const all = [...byKey.values()];
  let written = 0;
  for (let i = 0; i < all.length && i < VAULT_BACKFILL_MAX; i += VAULT_CAPTURE_MAX) {
    written += await captureVaultItems(db, vaultId, all.slice(i, i + VAULT_CAPTURE_MAX));
  }
  return written;
}

/**
 * Resolve a claimed list's CURRENT edit-token hash for this user, or null.
 *
 * This is the whole session-authorisation path: given a share code the caller
 * named and a session we've already verified, hand back the same hash the token
 * path would have produced. Re-read from the list row every time, so rotating the
 * edit token neither breaks the claim nor leaves a stale key behind.
 *
 * A share code with no claim for this user returns null — indistinguishable from a
 * code that doesn't exist, so this can't be used to probe for lists.
 */
export async function claimedEditHash(
  db: Db,
  userId: number,
  shareCode: string,
): Promise<string | null> {
  const code = normShareCode(shareCode);
  if (!code) return null;
  const rows = await db
    .select({ editTokenHash: lists.editTokenHash })
    .from(lists)
    .innerJoin(listClaims, eq(listClaims.listId, lists.id))
    .where(
      and(
        eq(lists.shareCode, code),
        eq(listClaims.userId, userId),
        eq(lists.status, "active"),
        isNull(lists.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.editTokenHash ?? null;
}

/**
 * Drop a claim — "remove from my account", the account-level counterpart of "remove
 * from this device". The list itself is untouched and anyone with its link (this
 * user included) can still open it. Scoped by userId in the WHERE, so one account
 * can't unclaim another's.
 */
export async function unclaimList(db: Db, userId: number, shareCode: string): Promise<boolean> {
  const code = normShareCode(shareCode);
  if (!code) return false;
  const target = await db
    .select({ id: lists.id })
    .from(lists)
    .where(eq(lists.shareCode, code))
    .limit(1);
  const listId = target[0]?.id;
  if (listId == null) return false;
  const done = await db
    .delete(listClaims)
    .where(and(eq(listClaims.userId, userId), eq(listClaims.listId, listId)))
    // no-arg .returning() — the neon-http | PGlite union's only shared overload
    .returning();
  return done.length > 0;
}
