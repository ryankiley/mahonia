// Passkey storage. Small and deliberately dumb — the interesting work (signature
// verification, origin/RP binding) belongs to @simplewebauthn/server, and the
// ceremony plumbing to server/utils/passkeys.ts.

import { and, desc, eq } from "drizzle-orm";
import { credentials } from "../db/schema";
import type { useAccountDb } from "./db";

type Db = Awaited<ReturnType<typeof useAccountDb>>;

/** How many passkeys one account may hold. Generous — a phone, a laptop, a
 *  hardware key and spares — while still bounding the row count per user. */
export const MAX_PASSKEYS_PER_USER = 20;

export interface PasskeySummary {
  id: number;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

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
    createdAt: new Date(r.createdAt).toISOString(),
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
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
  },
): Promise<void> {
  await db.insert(credentials).values({
    userId: input.userId,
    credentialId: input.credentialId,
    publicKey: input.publicKey,
    counter: input.counter,
    transports: input.transports?.length ? JSON.stringify(input.transports) : null,
    discoverable: input.discoverable,
    label: input.label?.slice(0, 60) || null,
  });
}

/** Look a credential up by the id the authenticator presented. Not scoped by
 *  user — for a discoverable ("usernameless") sign-in the credential is what
 *  TELLS us the user. */
export async function findCredential(db: Db, credentialId: string) {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.credentialId, credentialId))
    .limit(1);
  return rows[0] ?? null;
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
  const done = await db
    .delete(credentials)
    .where(and(eq(credentials.id, id), eq(credentials.userId, userId)))
    // no-arg .returning() — the neon-http | PGlite union's only shared overload
    .returning();
  return done.length > 0;
}
