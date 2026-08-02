// Deleting an account — the one operation here that destroys data across several
// tables at once, so it lives in a repo function rather than in the route handler.
// A route can only be exercised by booting a server; this can be driven directly
// against a throwaway database, which is what a delete this irreversible warrants.

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  authTokens,
  credentials,
  listClaims,
  lists,
  sessions,
  users,
  vaultFolders,
  vaultItems,
  vaults,
} from "../db/schema";
import { useAccountDb } from "./db";

type Db = Awaited<ReturnType<typeof useAccountDb>>;

export interface AccountDeletion {
  /** lists soft-deleted — 0 unless `deleteLists` was asked for */
  listsDeleted: number;
  /** whether a vault was found and removed */
  vaultDeleted: boolean;
}

/**
 * Delete `userId` and everything that exists only because of it.
 *
 * GOES, ALWAYS: the account row, its sessions and pending sign-in links, its
 * passkeys, its claims, and its vault with every item and folder in it. A vault has
 * exactly one owner, so none of that is shared — it's gone in the strong sense
 * rather than soft-deleted, because no link remains that could bring it back and
 * nobody else could miss it.
 *
 * STAYS BY DEFAULT: the lists. A list belongs to its EDIT LINK, not to the account;
 * a claim only ever added a bookmark on top. Deleting the account drops the
 * bookmark and leaves the list open to anyone holding the link, including you.
 * Taking someone's lists away as a side effect of closing an account would be the
 * most destructive thing this could do by accident, so it has to be asked for.
 *
 * `deleteLists` opts into removing them, and only the ones this account claimed.
 * Soft-delete, exactly as the owner pressing Delete on each one, so the nightly
 * purge reclaims them after the usual grace rather than vanishing them mid-read.
 */
export async function deleteAccount(
  db: Db,
  userId: number,
  opts: { deleteLists?: boolean } = {},
): Promise<AccountDeletion> {
  // Read the claims BEFORE dropping them, so the optional list delete still knows
  // which lists were this account's.
  const claimed = await db
    .select({ listId: listClaims.listId })
    .from(listClaims)
    .where(eq(listClaims.userId, userId));
  const claimedIds = claimed.map((c) => c.listId);

  let listsDeleted = 0;
  if (opts.deleteLists && claimedIds.length) {
    const now = new Date();
    // `isNull(deletedAt)` so a re-run can't re-stamp — and re-count — a list that
    // was already deleted. The number returned has to mean what it says.
    const gone = await db
      .update(lists)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(inArray(lists.id, claimedIds), isNull(lists.deletedAt)))
      .returning();
    listsDeleted = gone.length;
  }

  // The vault, children first: nothing cascades here, so removing the vault row
  // before its contents would strand them as rows nothing can reach.
  const owned = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.userId, userId));
  const vaultId = owned[0]?.id;
  if (vaultId != null) {
    await db.delete(vaultItems).where(eq(vaultItems.vaultId, vaultId));
    await db.delete(vaultFolders).where(eq(vaultFolders.vaultId, vaultId));
    await db.delete(vaults).where(eq(vaults.id, vaultId));
  }

  // Any list still bylined to this account loses the byline. Otherwise the read
  // views would resolve a name for a row that's gone — and worse, `users.id` is a
  // serial, so a later account could inherit the id and find its name on a
  // stranger's list.
  await db.update(lists).set({ authorUserId: null }).where(eq(lists.authorUserId, userId));

  await db.delete(listClaims).where(eq(listClaims.userId, userId));
  await db.delete(credentials).where(eq(credentials.userId, userId));
  await db.delete(authTokens).where(eq(authTokens.userId, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));

  return { listsDeleted, vaultDeleted: vaultId != null };
}
