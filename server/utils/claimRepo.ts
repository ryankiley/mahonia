// Claimed lists: the bridge between the capability model (a list belongs to
// whoever holds its edit link) and accounts (a list should still be there when you
// pick up a different device).
//
// A claim adds a SECOND way to prove the same capability. It never replaces the
// first: the edit link keeps working exactly as before, for claimers and
// non-claimers alike, and claiming a list takes nothing away from anyone else
// holding that link.

import { toIso } from "./time";
import { and, desc, eq } from "drizzle-orm";
import { listClaims, lists } from "../db/schema";
import type { Db } from "./db";
import { claimedLiveBy, findLiveByEditHashes, isLive } from "./listRepo";
import { sha256Hex } from "./tokens";
import { captureVaultItems, unitOf } from "./vaultRepo";
import { vaultIdOrMint } from "./vaultAuth";
import { VAULT_CAPTURE_MAX, captureFromList, type VaultCapture } from "../../shared/vault";
import { normalizeShareCode } from "../../shared/links";
import { CLAIMED_LIST_CAP, type ClaimedList } from "../../shared/types";

// CLAIMED_LIST_CAP (shared/types) is the one cap here: how many tokens one claim
// request may carry, since "Your lists" is a device registry a person built by hand
// and anything past it is not a real browser, and how many rows a read returns. The
// client reads the same number to know when the rows it holds are the whole account.

/** Ceiling on a single backfill. A personal gear collection is dozens of items;
 *  this only bounds the pathological account. */
const VAULT_BACKFILL_MAX = 1000;


const isToken = (t: unknown): t is string =>
  typeof t === "string" && t.length > 0 && t.length <= 200;

/**
 * Claim every list the caller can prove they hold, by presenting its edit token.
 *
 * The tokens are used and dropped — resolved to a list id, never stored. What
 * persists is (user, list), which is why a database dump still contains no write
 * capability for anyone's list.
 *
 * The sign-in sweep sends the lists the browser's registry calls yours: made,
 * imported or cloned there. One that arrived through someone else's edit link is
 * claimed only by choice (the sharing menu's claimOne, the connector's create_list),
 * because quietly attaching a shared list to your account is a surprise.
 *
 * Unresolvable tokens are skipped in silence rather than reported: a device
 * registry accumulates dead entries (deleted lists, rotated links), and a
 * per-token verdict would let a caller test arbitrary tokens for existence.
 * Returns the number newly claimed.
 */
export async function claimLists(
  db: Db,
  userId: number,
  editTokens: string[],
): Promise<number> {
  const owned = editTokens.filter(isToken).slice(0, CLAIMED_LIST_CAP);
  if (!owned.length) return 0;

  // Two statements for the whole batch, not two per token. Hashing is local and
  // synchronous, so the only round trips left are the resolve and the insert —
  // where a registry of 200 tokens used to cost 400 sequential ones, which on
  // Neon's HTTP driver (no pipelining) is the difference between a sign-in that
  // lands and one you watch happen.
  const rows = await findLiveByEditHashes(owned.map(sha256Hex), db);
  if (!rows.length) return 0;

  // SORTED, which is the part that matters. Two overlapping claims from the same
  // account (two tabs, or a retry racing its original) insert overlapping key sets;
  // if they take those keys in different orders they can wait on each other's
  // uncommitted rows and deadlock, and because this is now ONE statement a deadlock
  // rolls the whole batch back rather than one row. A stable order across callers
  // makes the circular wait impossible. The query has no ORDER BY, so the order it
  // returns is the planner's business, not something to rely on.
  //
  // The Set is belt-and-braces: `inArray` already collapses a repeated token, and
  // ON CONFLICT DO NOTHING tolerates a repeated pair within one statement (that
  // restriction belongs to DO UPDATE). It costs nothing and makes the row count
  // obviously equal to the key count.
  const listIds = [...new Set(rows.map((r) => r.id))].sort((a, b) => a - b);

  // ON CONFLICT DO NOTHING ... RETURNING gives back only the rows actually
  // inserted, so the count still means "newly claimed" and re-claiming stays a
  // no-op. Nothing to merge on a conflict — a claim is a bare (user, list) fact —
  // which is also why this needs none of the same-row-twice care captureVaultItems
  // takes with DO UPDATE.
  const done = await db
    .insert(listClaims)
    .values(listIds.map((listId) => ({ userId, listId })))
    .onConflictDoNothing({ target: [listClaims.userId, listClaims.listId] })
    .returning();
  return done.length;
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
    .where(claimedLiveBy(userId))
    .orderBy(desc(lists.updatedAt))
    .limit(CLAIMED_LIST_CAP);

  return rows.map((r) => ({
    shareCode: r.shareCode,
    slug: r.slug,
    title: r.title,
    totalMg: Number(r.totalWeightMg),
    version: r.version,
    displayUnit: unitOf(r.displayUnit) ?? "g",
    updatedAt: toIso(r.updatedAt),
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
    .where(claimedLiveBy(userId))
    .orderBy(desc(lists.updatedAt), desc(lists.id))
    .limit(CLAIMED_LIST_CAP);

  const byKey = new Map<string, VaultCapture>();
  for (const row of rows) {
    const items = Array.isArray(row.data?.items) ? row.data.items : [];
    // The query is newest first, so the first occurrence wins — the same "your
    // newest weight is your truth" rule the upsert itself follows.
    for (const cap of captureFromList(items)) byKey.getOrInsert(cap.normKey, cap);
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
  const vaultId = await vaultIdOrMint(db, userId);

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
  const code = normalizeShareCode(shareCode);
  if (!code) return null;
  const rows = await db
    .select({ editTokenHash: lists.editTokenHash })
    .from(lists)
    .innerJoin(listClaims, eq(listClaims.listId, lists.id))
    .where(
      and(
        eq(lists.shareCode, code),
        eq(listClaims.userId, userId),
        isLive(),
      ),
    )
    .limit(1);
  return rows[0]?.editTokenHash ?? null;
}
