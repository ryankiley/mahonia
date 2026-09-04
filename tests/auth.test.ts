import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import {
  MAGIC_LINK_TTL_MS,
  claimUnverifiedAccount,
  consumeMagicToken,
  createAccount,
  findOrCreateUser,
  issueMagicToken,
  normalizeEmail,
  sweepExpiredAuth,
} from "../server/utils/authSession";
import { existingCredentialIds, savePasskey } from "../server/utils/credentialRepo";
import { sha256Hex } from "../server/utils/tokens";
import { createTestDb, type TestDb } from "./helpers/db";

type DB = TestDb;
async function freshDb(): Promise<DB> {
  return createTestDb(ACCOUNT_DDL);
}

describe("normalizeEmail — the identity rule", () => {
  it("lowercases and trims, so one person is one account", () => {
    expect(normalizeEmail("  Alex@Example.COM ")).toBe("alex@example.com");
  });

  it("rejects what obviously isn't an address", () => {
    for (const bad of ["", "   ", "nope", "a@b", "two @spaces.com", "@example.com", "a@.com", 42, null, undefined])
      expect(normalizeEmail(bad as unknown)).toBeNull();
  });

  it("rejects an absurdly long address rather than storing it", () => {
    expect(normalizeEmail(`${"a".repeat(250)}@example.com`)).toBeNull();
  });
});

describe("findOrCreateUser", () => {
  let db: DB;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("creates on first sight and returns the same account after", async () => {
    const a = await findOrCreateUser(db as any, "ryan@example.com");
    const b = await findOrCreateUser(db as any, "ryan@example.com");
    expect(b.id).toBe(a.id);
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });

  it("keeps different addresses apart", async () => {
    const a = await findOrCreateUser(db as any, "a@example.com");
    const b = await findOrCreateUser(db as any, "b@example.com");
    expect(a.id).not.toBe(b.id);
  });
});

describe("magic links", () => {
  let db: DB;
  let userId: number;
  beforeEach(async () => {
    db = await freshDb();
    userId = (await findOrCreateUser(db as any, "ryan@example.com")).id;
  });

  it("stores only the hash — the raw token is never written down", async () => {
    const token = await issueMagicToken(db as any, userId);
    const rows = await db.select().from(schema.authTokens);
    expect(rows[0]!.tokenHash).toBe(sha256Hex(token));
    expect(rows.some((r) => r.tokenHash === token)).toBe(false);
  });

  it("redeems once, then never again", async () => {
    const token = await issueMagicToken(db as any, userId);
    expect((await consumeMagicToken(db as any, token))?.id).toBe(userId);
    // the replay a forwarded email (or a second click) would produce
    expect(await consumeMagicToken(db as any, token)).toBeNull();
  });

  it("refuses an unknown or empty token", async () => {
    expect(await consumeMagicToken(db as any, "")).toBeNull();
    expect(await consumeMagicToken(db as any, "not-a-real-token")).toBeNull();
  });

  it("refuses an expired token", async () => {
    const token = await issueMagicToken(db as any, userId);
    await db
      .update(schema.authTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.authTokens.userId, userId));
    expect(await consumeMagicToken(db as any, token)).toBeNull();
  });

  it("invalidates the previous link when a new one is requested", async () => {
    const first = await issueMagicToken(db as any, userId);
    const second = await issueMagicToken(db as any, userId);
    // an inbox must never hold two simultaneously-valid keys to one account
    expect(await consumeMagicToken(db as any, first)).toBeNull();
    expect((await consumeMagicToken(db as any, second))?.id).toBe(userId);
  });

  it("keeps one user's link from opening another's account", async () => {
    const otherId = (await findOrCreateUser(db as any, "someone@example.com")).id;
    const token = await issueMagicToken(db as any, otherId);
    expect((await consumeMagicToken(db as any, token))?.id).toBe(otherId);
  });
});

// Account pre-hijacking, the unverified-email variant: passkey signup takes an
// address from an unauthenticated body, so anyone can create an account with a
// stranger's address and leave a discoverable passkey on it. Because sign-in
// resolves by address, the stranger later lands in that same row — and the
// passkey re-opens it whenever the attacker likes.
//
// The whole defence is one rule: a link redeemed against an address is the only
// proof anyone holds that inbox, so the first time that proof arrives, everything
// on the account that predates it goes. These tests are that rule from both ends
// — it has to fire on the attack, and it must never fire on an ordinary sign-in.
describe("an address is only a claim until a link comes back", () => {
  let db: DB;
  beforeEach(async () => {
    db = await freshDb();
  });

  const liveSession = (userId: number, tokenHash: string) =>
    db
      .insert(schema.sessions)
      .values({ tokenHash, userId, expiresAt: new Date(Date.now() + 60_000) });

  const addPasskey = (userId: number, credentialId: string) =>
    savePasskey(db as any, {
      userId,
      credentialId,
      publicKey: "cHVibGlj",
      counter: 0,
      discoverable: true,
      label: null,
    });

  const sessionHashes = async () =>
    (await db.select().from(schema.sessions)).map((r) => r.tokenHash);

  const isVerified = async (id: number) =>
    (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0]!.emailVerified;

  /** Exactly what verify.post.ts does with a redeemed link, in its order. */
  async function signInWithLink(token: string) {
    const user = await consumeMagicToken(db as any, token);
    if (!user) return null;
    if (!user.emailVerified) await claimUnverifiedAccount(db as any, user.id);
    return user;
  }

  it("records which signup route made the account", async () => {
    // the passkey route never mails the address, so it has proved nothing
    const bySignup = await createAccount(db as any, "passkey@example.com");
    expect(await isVerified(bySignup.id)).toBe(false);
    // the magic-link route is a round trip through the inbox by construction
    const byLink = await findOrCreateUser(db as any, "link@example.com");
    expect(await isVerified(byLink.id)).toBe(true);
  });

  it("grandfathers the accounts that predate the column", async () => {
    // The column arrives as two statements — ADD ... DEFAULT true, then ALTER ...
    // SET DEFAULT false — and they do opposite jobs on purpose. Rows written
    // before the distinction existed can't be sorted into verified and not, so
    // they're taken as verified; everything after earns it. Reordering them (or
    // dropping the second) would quietly evict the passkeys of every account that
    // already existed, on their next sign-in.
    // the schema as it stood BEFORE the column existed — a filtered group is still
    // just a group as far as the helper is concerned
    const deployed = await createTestDb(ACCOUNT_DDL.filter((s) => !s.includes("email_verified")));
    // written the way the old code wrote it, with no such column to fill in
    await deployed.execute(sql.raw(`insert into users (email) values ('old@example.com')`));

    // the deploy: the same idempotent DDL, now with the column in it
    for (const stmt of ACCOUNT_DDL) await deployed.execute(sql.raw(stmt));
    // ...after which the COLUMN DEFAULT is what an insert that says nothing about
    // verification gets. Both real insert paths name it explicitly, so this is the
    // backstop: a future one that forgets lands on unproved, which is the side
    // that fails safe.
    await deployed.execute(sql.raw(`insert into users (email) values ('new@example.com')`));

    // and then the NEXT cold start runs the whole DDL again over the migrated
    // database. It must not backfill a second time: that would mark every unproved
    // account proved and disarm the eviction for good.
    for (const stmt of ACCOUNT_DDL) await deployed.execute(sql.raw(stmt));

    const verified = async (email: string) =>
      (await deployed.select().from(schema.users).where(eq(schema.users.email, email)))[0]!
        .emailVerified;
    expect(await verified("old@example.com")).toBe(true);
    expect(await verified("new@example.com")).toBe(false);
  });

  it("evicts the passkey and every session when the address's owner first signs in", async () => {
    // the attacker: a passkey signup against an address that isn't theirs, plus
    // the session it started and another opened later
    const seeded = await createAccount(db as any, "ryan@example.com");
    await addPasskey(seeded.id, "attacker-key");
    await liveSession(seeded.id, "attacker-signup");
    await liveSession(seeded.id, "attacker-later");

    // the real owner asks for a sign-in link, and is handed the attacker's row —
    // that resolution is the vulnerability, and it is NOT what gets fixed
    const found = await findOrCreateUser(db as any, "ryan@example.com");
    expect(found.id).toBe(seeded.id);
    // asking for a link proves nothing, so it must not disarm the eviction
    expect(await isVerified(found.id)).toBe(false);

    const token = await issueMagicToken(db as any, found.id);
    expect((await signInWithLink(token))?.id).toBe(seeded.id);

    // the passkey that could re-open the account at will is gone...
    expect(await existingCredentialIds(db as any, seeded.id)).toHaveLength(0);
    // ...and so is every session it had already started
    expect(await sessionHashes()).toEqual([]);
    // the address is proved now, so this happens exactly once
    expect(await isVerified(seeded.id)).toBe(true);
  });

  it("leaves an ordinary sign-in alone — a second device doesn't sign the first one out", async () => {
    const user = await findOrCreateUser(db as any, "ryan@example.com");
    await liveSession(user.id, "phone");

    const token = await issueMagicToken(db as any, user.id);
    await signInWithLink(token);

    // an eviction firing here would log people out of their own devices every
    // time they used a sign-in link
    expect(await sessionHashes()).toEqual(["phone"]);
  });

  it("never touches a verified account's passkeys, however many times it signs in", async () => {
    const user = await findOrCreateUser(db as any, "ryan@example.com");
    await addPasskey(user.id, "their-own-key");

    for (const _ of [1, 2]) {
      const token = await issueMagicToken(db as any, user.id);
      await signInWithLink(token);
    }

    expect(await existingCredentialIds(db as any, user.id)).toHaveLength(1);
  });

  it("disarms after the takeover: a passkey added afterwards survives", async () => {
    const seeded = await createAccount(db as any, "ryan@example.com");
    await addPasskey(seeded.id, "attacker-key");
    await signInWithLink(await issueMagicToken(db as any, seeded.id));

    // now it's genuinely their account, and their own key has to stick
    await addPasskey(seeded.id, "owner-key");
    await signInWithLink(await issueMagicToken(db as any, seeded.id));
    expect(await existingCredentialIds(db as any, seeded.id)).toHaveLength(1);
  });

  it("keeps its hands off every other account", async () => {
    const seeded = await createAccount(db as any, "ryan@example.com");
    await addPasskey(seeded.id, "attacker-key");
    const bystander = await findOrCreateUser(db as any, "someone@example.com");
    await addPasskey(bystander.id, "bystander-key");
    await liveSession(bystander.id, "bystander-session");

    await signInWithLink(await issueMagicToken(db as any, seeded.id));

    expect(await existingCredentialIds(db as any, bystander.id)).toHaveLength(1);
    expect(await sessionHashes()).toEqual(["bystander-session"]);
  });
});

describe("sweepExpiredAuth", () => {
  let db: DB;
  let userId: number;
  beforeEach(async () => {
    db = await freshDb();
    userId = (await findOrCreateUser(db as any, "ryan@example.com")).id;
  });

  it("drops expired sessions and leaves live ones", async () => {
    await db.insert(schema.sessions).values([
      { tokenHash: "live", userId, expiresAt: new Date(Date.now() + 60_000) },
      { tokenHash: "dead", userId, expiresAt: new Date(Date.now() - 60_000) },
    ]);
    await sweepExpiredAuth(db as any);
    const rows = await db.select().from(schema.sessions);
    expect(rows.map((r) => r.tokenHash)).toEqual(["live"]);
  });

  it("drops long-spent links but keeps a just-consumed one briefly", async () => {
    // a link consumed seconds ago stays, so a double-click gets "already used"
    // rather than a bare "unknown link" while the first click sets up its session
    await db.insert(schema.authTokens).values([
      { tokenHash: "fresh-consumed", userId, expiresAt: new Date(Date.now() + 60_000), consumedAt: new Date() },
      {
        tokenHash: "old-consumed",
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(Date.now() - MAGIC_LINK_TTL_MS - 60_000),
      },
      { tokenHash: "expired", userId, expiresAt: new Date(Date.now() - 60_000) },
    ]);
    await sweepExpiredAuth(db as any);
    const rows = await db.select().from(schema.authTokens);
    expect(rows.map((r) => r.tokenHash)).toEqual(["fresh-consumed"]);
  });
});
