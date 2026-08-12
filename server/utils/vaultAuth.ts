import type { H3Event } from "h3";
import { createError } from "h3";
import { eq, sql } from "drizzle-orm";
import { vaults } from "../db/schema";
import { useVaultDb } from "./db";
import { resolveSession } from "./authSession";

/**
 * The ONE place a request becomes a vault id. Every vault endpoint goes through
 * here, so the authorisation rule is written down once and a new endpoint can't
 * invent a looser one — the same discipline `requireEditHash` gives lists.
 *
 * A VAULT BELONGS TO AN ACCOUNT. That is the whole rule, and it is deliberately
 * different from a list.
 *
 * Lists are link-owned and always will be: a list is a document you hand to
 * someone, and requiring a login to read what you were sent would be the wrong
 * product. A vault is the opposite — it's the durable record of what YOU own,
 * accumulated over years, and the one thing on this site where losing a link
 * means losing something you can't rebuild from memory. Link ownership bought
 * cross-device sharing that nobody asked for and charged for it with an
 * unrecoverable secret, a transfer-link flow, and a merge path for when two
 * devices disagreed. An account is simply the right primitive for a thing that
 * has to persist.
 *
 * So there is no vault token, no Authorization header on this path, and no
 * anonymous vault. The session cookie is the capability — which also happens to
 * fix the capture beacon: `navigator.sendBeacon` can't set headers, but it is
 * same-origin, so the cookie rides along on its own.
 */

type Db = Awaited<ReturnType<typeof useVaultDb>>;

/**
 * Resolve the signed-in user's vault, or 401 — for the WRITES (folder ops,
 * remove/restore), which need an existing vault to act on. Reads go through
 * resolveVaultForRead below, where "no vault yet" is a normal state, not an
 * error.
 *
 * `last_seen_at` is bumped on every resolve so an abandoned vault can be reaped on
 * the same schedule as an abandoned list, instead of accumulating forever. That
 * bump also clears any soft-delete the reaper had set: a vault whose owner comes
 * back inside the purge grace revives simply by being used, with no separate
 * restore path to remember to call.
 */
export async function requireVault(event: H3Event): Promise<{ db: Db; vaultId: number }> {
  const user = await resolveSession(event);
  if (!user) throw createError({ statusCode: 401, statusMessage: "Sign in to use your vault" });

  const db = await useVaultDb();
  const vaultId = await touchVaultByUser(db, user.id);
  if (vaultId == null) throw createError({ statusCode: 401, statusMessage: "No vault yet" });
  return { db, vaultId };
}

/**
 * Resolve the signed-in user's vault for a READ, or null when there is nothing
 * to read yet.
 *
 * Vaults are minted lazily on first capture, and /vault is where sign-in lands —
 * so a fresh account arriving with no vault row is the NORMAL first visit, and
 * the read endpoints answer it with their empty shape. A 401 here read as a
 * connection error in the client and put an error banner over the empty state
 * the page was trying to show. Signed-out still 401s: that one IS an auth
 * failure, and the clients don't call these endpoints signed out anyway.
 */
export async function resolveVaultForRead(
  event: H3Event,
): Promise<{ db: Db; vaultId: number } | null> {
  const user = await resolveSession(event);
  if (!user) throw createError({ statusCode: 401, statusMessage: "Sign in to use your vault" });

  const db = await useVaultDb();
  const vaultId = await touchVaultByUser(db, user.id);
  return vaultId == null ? null : { db, vaultId };
}

/**
 * Resolve a user's vault AND mark it used — bump last_seen_at, clear any
 * soft-delete. Split out of requireVault so the rule can be tested without an
 * H3Event; what's left up there is error handling.
 */
export async function touchVaultByUser(db: Db, userId: number): Promise<number | null> {
  const rows = await db
    .update(vaults)
    .set({ lastSeenAt: sql`now()`, deletedAt: null })
    .where(eq(vaults.userId, userId))
    .returning();
  return rows[0]?.id ?? null;
}

/**
 * Mint the account's vault.
 *
 * Vaults are minted LAZILY, on the first capture that has something to store, for
 * the same reason a list isn't created until it has real content: signing in
 * shouldn't leave a row behind. The unique index on user_id is what makes this
 * safe when two captures race — the loser's insert is swallowed and it re-reads
 * the winner's row, so an account can never end up with two vaults.
 */
export async function mintVault(db: Db, userId: number): Promise<number> {
  const rows = await db
    .insert(vaults)
    .values({ userId })
    .onConflictDoNothing({ target: vaults.userId })
    .returning();
  if (rows[0]) return rows[0].id;
  const existing = await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.userId, userId));
  return existing[0]!.id;
}

/**
 * Resolve the signed-in user's vault, creating it if this is their first capture.
 *
 * ONLY for capture — the write that happens automatically as you build a list, and
 * the one path where "there isn't a vault yet" is the normal first case rather
 * than an error. Still requires a session: an anonymous capture has no owner to
 * file the gear under, so it is refused rather than dropped into a vault nobody
 * could reach again.
 */
export async function resolveOrMintVault(event: H3Event): Promise<{ db: Db; vaultId: number }> {
  const user = await resolveSession(event);
  if (!user) throw createError({ statusCode: 401, statusMessage: "Sign in to use your vault" });

  const db = await useVaultDb();
  const existing = await touchVaultByUser(db, user.id);
  if (existing != null) return { db, vaultId: existing };
  return { db, vaultId: await mintVault(db, user.id) };
}
