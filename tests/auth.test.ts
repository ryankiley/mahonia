import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import {
  MAGIC_LINK_TTL_MS,
  consumeMagicToken,
  findOrCreateUser,
  issueMagicToken,
  normalizeEmail,
  sweepExpiredAuth,
} from "../server/utils/authSession";
import { sha256Hex } from "../server/utils/tokens";

type DB = ReturnType<typeof drizzle>;
async function freshDb(): Promise<DB> {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of ACCOUNT_DDL) await db.execute(sql.raw(stmt));
  return db;
}

describe("normalizeEmail — the identity rule", () => {
  it("lowercases and trims, so one person is one account", () => {
    expect(normalizeEmail("  Ryan@Example.COM ")).toBe("ryan@example.com");
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
