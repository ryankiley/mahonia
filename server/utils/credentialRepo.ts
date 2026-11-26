// Passkey storage. Small and deliberately dumb — the interesting work (signature
// verification, origin/RP binding) belongs to @simplewebauthn/server, and the
// ceremony plumbing to server/utils/passkeys.ts.

import { toIso } from "./time";
import { and, desc, eq, getTableColumns, lt } from "drizzle-orm";
import { credentials, users } from "../db/schema";
import { notRetired } from "./accessTokens";
import { countRows, type Db } from "./db";
import { cleanLine } from "./http";
import type { PasskeySummary } from "../../shared/types";
import { isSerialId } from "../../shared/ops";

/** How many passkeys one account may hold. Generous — a phone, a laptop, a
 *  hardware key and spares — while still bounding the row count per user. */
export const MAX_PASSKEYS_PER_USER = 20;


export async function listPasskeys(db: Db, userId: number): Promise<PasskeySummary[]> {
  const rows = await db
    .select({
      id: credentials.id,
      label: credentials.label,
      createdAt: credentials.createdAt,
      lastUsedAt: credentials.lastUsedAt,
    })
    .from(credentials)
    .where(eq(credentials.userId, userId))
    .orderBy(desc(credentials.createdAt));
  return rows.map((r) => ({
    id: r.id,
    label: r.label ?? null,
    createdAt: toIso(r.createdAt),
    lastUsedAt: r.lastUsedAt ? toIso(r.lastUsedAt) : null,
  }));
}

/** The credential ids this user already has, so registration can tell the
 *  authenticator "not this one again" instead of silently creating a duplicate. */
export async function existingCredentialIds(db: Db, userId: number): Promise<string[]> {
  const rows = await db
    .select({ credentialId: credentials.credentialId })
    .from(credentials)
    .where(eq(credentials.userId, userId));
  return rows.map((r) => r.credentialId);
}

/** A passkey's label as it is kept and as it is mailed: one short line. */
export const cleanPasskeyLabel = (raw: string): string => cleanLine(raw, 60);

export async function savePasskey(
  db: Db,
  input: {
    userId: number;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports?: string[] | null;
    discoverable: boolean;
    label?: string | null;
    /** the account's address was unproven when whatever authorized this key was
     *  checked: see sessions.unproven in server/db/schema.ts */
    unproven: boolean;
  },
): Promise<number> {
  const [row] = await db.insert(credentials).values({
    userId: input.userId,
    credentialId: input.credentialId,
    publicKey: input.publicKey,
    counter: input.counter,
    transports: input.transports?.length ? JSON.stringify(input.transports) : null,
    discoverable: input.discoverable,
    label: (input.label && cleanPasskeyLabel(input.label)) || null,
    unproven: input.unproven,
  }).returning({ id: credentials.id });
  return row!.id;
}

/**
 * Take a just-saved passkey back out if it is one beyond the cap: true when it was.
 *
 * Counting before a save can't hold the cap against saves that arrive together: each
 * reads the same count, finds room and writes. So the cap is settled afterwards, by
 * the rows: a key is beyond the cap when MAX_PASSKEYS_PER_USER of the account's keys
 * have a smaller id, which is to say were saved before it.
 *
 * Each request judges and removes ONLY ITS OWN row, by that order. "Over the cap, so
 * undo mine" would have every racing request undo its own and leave the account
 * under the cap with nothing saved; and trimming whichever rows are newest would
 * delete a key another request has already told its owner was kept. By id, the
 * earliest MAX_PASSKEYS_PER_USER rows never see that many before them, so they all
 * stay, and the later ones go. (An id is taken a moment before its row is visible,
 * so a later key can count before an earlier one has landed and be kept: the cap can
 * then be passed by that key. It errs that way only, never by removing a kept key.)
 */
export async function removePasskeyBeyondCap(db: Db, userId: number, id: number): Promise<boolean> {
  const earlier = await countRows(db, credentials, and(eq(credentials.userId, userId), lt(credentials.id, id)));
  if (earlier < MAX_PASSKEYS_PER_USER) return false;
  await deletePasskey(db, userId, id);
  return true;
}

/** Look a credential up by the id the authenticator presented. Not scoped by
 *  user — for a discoverable ("usernameless") sign-in the credential is what
 *  TELLS us the user. A key made while the account's address was unproven finds
 *  nothing once it is proven (claimUnverifiedAccount); `accountUnproven` says what
 *  the address was as this read happened, for the session the sign-in starts, and
 *  `email` is the account's, from the same join, for the sign-in's answer. */
export async function findCredential(db: Db, credentialId: string) {
  const rows = await db
    .select({ credential: getTableColumns(credentials), emailVerified: users.emailVerified, email: users.email })
    .from(credentials)
    .innerJoin(users, eq(users.id, credentials.userId))
    .where(and(eq(credentials.credentialId, credentialId), notRetired(credentials.unproven)))
    .limit(1);
  const row = rows[0];
  return row ? { ...row.credential, accountUnproven: !row.emailVerified, email: row.email } : null;
}

/** Record a successful use: bump the signature counter and stamp the time. The
 *  counter is what lets an authenticator that keeps one prove it hasn't been
 *  cloned; the comparison itself is verifyAuthenticationResponse's job. */
export async function touchCredential(db: Db, id: number, counter: number): Promise<void> {
  await db
    .update(credentials)
    .set({ counter, lastUsedAt: new Date() })
    .where(eq(credentials.id, id));
}

/** Remove a passkey. Scoped by userId in the WHERE so one account can't delete
 *  another's; returns whether anything was actually removed. */
export async function deletePasskey(db: Db, userId: number, id: number): Promise<boolean> {
  // an id the column can't hold is "nothing removed", not an overflow error
  if (!isSerialId(id)) return false;
  const done = await db
    .delete(credentials)
    .where(and(eq(credentials.id, id), eq(credentials.userId, userId)))
    .returning();
  return done.length > 0;
}
