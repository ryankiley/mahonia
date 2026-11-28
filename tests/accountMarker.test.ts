// The account marker, server side: which account a browser's unsent edits are filed
// under. It was a hash of the account's id and address, which anyone holding the
// marker and the address could search for the id. It is now random and stored with
// the account. A browser may still hold edits filed under the old one, so
// /api/auth/me answers both for a while (formerAccountMarker says until when).

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import meGet from "../server/api/auth/me.get";
import * as schema from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { createAccount, ensureAccountMarker, findOrCreateUser } from "../server/utils/authSession";
import { createTestDb, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";
import { makeEvent } from "./helpers/http";
import { memoryKv } from "./helpers/kv";
import { signInCookie } from "./helpers/session";

vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));
// the endpoint's rate limit keeps its counts in Nitro's store, which plain vitest lacks
vi.stubGlobal("useStorage", () => memoryKv());

const EMAIL = "ryan@example.com";
const MARKER = /^[0-9a-f]{16}$/;

let db: TestDb;
let userId: number;
beforeEach(async () => {
  db = await createTestDb(ACCOUNT_DDL);
  dbState.db = db;
  userId = (await findOrCreateUser(db, EMAIL)).id;
});

/** The marker as the account's row holds it. */
const stored = async (id: number) =>
  (await db.select({ marker: schema.users.accountMarker }).from(schema.users).where(eq(schema.users.id, id)))[0]!.marker;
/** An account as one from before the column has it: no marker yet. */
const unmark = (id: number) => db.update(schema.users).set({ accountMarker: null }).where(eq(schema.users.id, id));
/** A new sign-in to `id` on some browser, and what /api/auth/me answers it. */
async function me(id: number) {
  const { cookie } = await signInCookie(db, id);
  const answer = (await meGet(makeEvent("/api/auth/me", { headers: { cookie } }))) as {
    user: { account: string; accountNow: string } | null;
  };
  return answer.user!;
}
/** What the marker used to be, worked out the way anyone holding it and the address could. */
const derived = (id: number, email: string) =>
  createHash("sha256").update(`account:${id}:${email}`).digest("hex").slice(0, 16);

describe("an account's marker", () => {
  it("is made with the account, at random, by either way of making one", async () => {
    const byPasskey = await createAccount(db, "passkey@example.com");
    const [byLink, bySignup] = [await stored(userId), await stored(byPasskey.id)];

    expect(byLink).toMatch(MARKER);
    expect(bySignup).toMatch(MARKER);
    expect(bySignup).not.toBe(byLink);
    // nothing about the account is in it
    expect(byLink).not.toBe(derived(userId, EMAIL));
    expect((await me(userId)).accountNow).toBe(byLink);
  });

  it("is the same on every device, and through a change of address", async () => {
    const first = await me(userId);
    const second = await me(userId);
    expect(first.accountNow).toMatch(MARKER);
    expect(second.accountNow).toBe(first.accountNow);

    await db.update(schema.users).set({ email: "new@example.com" }).where(eq(schema.users.id, userId));
    const moved = await me(userId);
    expect(moved.accountNow).toBe(first.accountNow);
    // which the one it replaces was not
    expect(moved.account).not.toBe(first.account);
  });

  it("is given to an account from before there was one the first time it signs in, and kept", async () => {
    await unmark(userId);

    const first = await me(userId);
    expect(first.accountNow).toMatch(MARKER);
    expect(await stored(userId)).toBe(first.accountNow);
    expect((await me(userId)).accountNow).toBe(first.accountNow);
  });

  it("is one marker when two requests find an account without one together", async () => {
    await unmark(userId);
    // both have read the row and found no marker: each goes to make one
    const [a, b] = await Promise.all([ensureAccountMarker(db, userId), ensureAccountMarker(db, userId)]);
    expect(a).toMatch(MARKER);
    expect(b).toBe(a);
    expect(await stored(userId)).toBe(a);

    // and as two browsers asking at once
    await unmark(userId);
    const [here, there] = await Promise.all([me(userId), me(userId)]);
    expect(there.accountNow).toBe(here.accountNow);
    expect(await stored(userId)).toBe(here.accountNow);
  });

  it("leaves an account that has one alone", async () => {
    const before = await stored(userId);
    expect(await ensureAccountMarker(db, userId)).toBe(before);
    expect(await stored(userId)).toBe(before);
  });

  it("cannot be held by two accounts", async () => {
    const other = await findOrCreateUser(db, "someone-else@example.com");
    const taken = (await stored(userId))!;
    await expect(
      db.update(schema.users).set({ accountMarker: taken }).where(eq(schema.users.id, other.id)),
    ).rejects.toThrow();
  });

  // An app shell from before reads `account` and nothing else, and has filed edits
  // under what it said. It goes on being told the same thing.
  it("still answers the marker browsers filed under before, as `account`", async () => {
    const answer = await me(userId);
    expect(answer.account).toBe(derived(userId, EMAIL));
    expect(answer.accountNow).toBe(await stored(userId));
    expect(answer.accountNow).not.toBe(answer.account);
  });
});
