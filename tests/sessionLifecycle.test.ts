// The session half of authSession.ts — auth.test.ts covers the magic link; this
// covers what the redeemed link BUYS: the cookie-backed session, its sliding
// expiry, and the two ways out (this device, every device).
//
// The lifecycle functions read their connection through useAccountDb() and their
// identity through a real H3 event's cookies, so the tests fabricate both: a
// PGlite database swapped in for useAccountDb, and events built over bare node
// req/res mocks. That keeps the CODE under test unchanged — resolveSession is
// exercised exactly as a request would, cookie parsing and cookie re-setting
// included, which is where the sliding-expiry bug the refresh comment warns
// about would actually live.

import { eq } from "drizzle-orm";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent, type H3Event } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import {
  SESSION_COOKIE,
  SESSION_HINT_COOKIE,
  endAllSessions,
  endSession,
  findOrCreateUser,
  resolveSession,
  startSession,
} from "../server/utils/authSession";
import { sha256Hex } from "../server/utils/tokens";
import { createTestDb, type TestDb } from "./helpers/db";
import { setCookieValue } from "./helpers/http";

type DB = TestDb;
async function freshDb(): Promise<DB> {
  return createTestDb(ACCOUNT_DDL);
}

// resolveSession/endSession/endAllSessions reach for useAccountDb() themselves,
// so point it at this file's throwaway database.
const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../server/utils/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../server/utils/db")>();
  return { ...mod, useAccountDb: async () => state.db };
});

/** A minimal real H3 event: enough request for getCookie, enough response for
 *  setCookie. No server boots — the event IS the interface under test. */
function makeEvent(cookie?: string): H3Event {
  const req = new IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/";
  req.headers = { host: "mahonia.test" };
  if (cookie) req.headers.cookie = cookie;
  req.push(null);
  return createEvent(req, new ServerResponse(req));
}

// Just past the un-exported 24h SESSION_REFRESH_AFTER_MS floor.
const STALE_AGE_MS = 25 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sign a user in and hand back the raw cookie value a browser would replay. */
async function signIn(db: DB, userId: number): Promise<string> {
  const event = makeEvent();
  await startSession(event, db as never, userId);
  const token = setCookieValue(event, SESSION_COOKIE);
  expect(token).toBeTruthy();
  return token!;
}

describe("startSession → resolveSession", () => {
  let db: DB;
  let userId: number;
  beforeEach(async () => {
    db = await freshDb();
    state.db = db;
    userId = (await findOrCreateUser(db as never, "ryan@example.com")).id;
  });

  it("round-trips: the cookie a sign-in sets is the credential resolve accepts", async () => {
    const start = makeEvent();
    await startSession(start, db as never, userId);
    const token = setCookieValue(start, SESSION_COOKIE)!;
    // the readable hint rides along, carrying no capability
    expect(setCookieValue(start, SESSION_HINT_COOKIE)).toBe("1");
    // only the hash ever touches the table — a dump mints no sign-in
    const rows = await db.select().from(schema.sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256Hex(token));

    const user = await resolveSession(makeEvent(`${SESSION_COOKIE}=${token}`));
    expect(user).toEqual({ id: userId, email: "ryan@example.com", displayName: null });
  });

  it("resolves nothing for no cookie, a made-up cookie, or an expired session", async () => {
    const token = await signIn(db, userId);
    expect(await resolveSession(makeEvent())).toBeNull();
    expect(await resolveSession(makeEvent(`${SESSION_COOKIE}=not-a-real-token`))).toBeNull();

    await db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessions.userId, userId));
    expect(await resolveSession(makeEvent(`${SESSION_COOKIE}=${token}`))).toBeNull();
  });

  it("leaves a fresh session alone — no row write, no re-set cookie", async () => {
    const token = await signIn(db, userId);
    const before = (await db.select().from(schema.sessions))[0]!;

    const event = makeEvent(`${SESSION_COOKIE}=${token}`);
    expect((await resolveSession(event))?.id).toBe(userId);

    // under the 24h refresh floor: the row is untouched and the response carries
    // no cookies — this is the write-per-request the floor exists to avoid
    const after = (await db.select().from(schema.sessions))[0]!;
    expect(after.lastUsedAt.getTime()).toBe(before.lastUsedAt.getTime());
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(event.node.res.getHeader("set-cookie")).toBeUndefined();
  });

  it("slides a session past the refresh floor: row bumped AND cookie re-set", async () => {
    const token = await signIn(db, userId);
    // age the session as though it were signed in 25h ago and unused since
    const staleLastUsed = new Date(Date.now() - STALE_AGE_MS);
    const staleExpiry = new Date(Date.now() + 65 * DAY_MS);
    await db
      .update(schema.sessions)
      .set({ lastUsedAt: staleLastUsed, expiresAt: staleExpiry })
      .where(eq(schema.sessions.userId, userId));

    const event = makeEvent(`${SESSION_COOKIE}=${token}`);
    expect((await resolveSession(event))?.id).toBe(userId);

    const after = (await db.select().from(schema.sessions))[0]!;
    expect(after.lastUsedAt.getTime()).toBeGreaterThan(staleLastUsed.getTime());
    // a fresh 90-day window, not the old one shortened
    expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now() + 80 * DAY_MS);
    // and the COOKIES slid with it — same token, new expiry. Without this the
    // browser drops the cookie 90 days after sign-in however often it's used.
    expect(setCookieValue(event, SESSION_COOKIE)).toBe(token);
    expect(setCookieValue(event, SESSION_HINT_COOKIE)).toBe("1");
  });
});

describe("endSession — sign out THIS device", () => {
  let db: DB;
  let userId: number;
  beforeEach(async () => {
    db = await freshDb();
    state.db = db;
    userId = (await findOrCreateUser(db as never, "ryan@example.com")).id;
  });

  it("deletes only the caller's row — other devices and other people stay signed in", async () => {
    const mine = await signIn(db, userId);
    const myOtherDevice = await signIn(db, userId);
    const otherId = (await findOrCreateUser(db as never, "someone@example.com")).id;
    const theirs = await signIn(db, otherId);

    const event = makeEvent(`${SESSION_COOKIE}=${mine}`);
    await endSession(event);

    const left = (await db.select().from(schema.sessions)).map((r) => r.tokenHash);
    expect(left).not.toContain(sha256Hex(mine));
    expect(left).toContain(sha256Hex(myOtherDevice));
    expect(left).toContain(sha256Hex(theirs));
    // both cookies cleared, and the dead token no longer resolves anywhere
    expect(setCookieValue(event, SESSION_COOKIE)).toBe("");
    expect(setCookieValue(event, SESSION_HINT_COOKIE)).toBe("");
    expect(await resolveSession(makeEvent(`${SESSION_COOKIE}=${mine}`))).toBeNull();
  });

  it("is a safe no-op with no cookie at all", async () => {
    await signIn(db, userId);
    await endSession(makeEvent());
    expect(await db.select().from(schema.sessions)).toHaveLength(1);
  });
});

describe("endAllSessions — sign out EVERYWHERE", () => {
  let db: DB;
  let userId: number;
  beforeEach(async () => {
    db = await freshDb();
    state.db = db;
    userId = (await findOrCreateUser(db as never, "ryan@example.com")).id;
  });

  it("takes every session for the account — the caller's own included — and counts them", async () => {
    const mine = await signIn(db, userId);
    await signIn(db, userId);
    await signIn(db, userId);
    const otherId = (await findOrCreateUser(db as never, "someone@example.com")).id;
    const theirs = await signIn(db, otherId);

    const event = makeEvent(`${SESSION_COOKIE}=${mine}`);
    expect(await endAllSessions(event, userId)).toBe(3);

    // deliberately not spared: the device you press the button on may be the
    // compromised one, so it goes too
    expect(await resolveSession(makeEvent(`${SESSION_COOKIE}=${mine}`))).toBeNull();
    const left = await db.select().from(schema.sessions);
    expect(left).toHaveLength(1);
    expect(left[0]!.tokenHash).toBe(sha256Hex(theirs));
    expect(setCookieValue(event, SESSION_COOKIE)).toBe("");
  });

  it("reports zero for an account with nothing to end", async () => {
    expect(await endAllSessions(makeEvent(), userId)).toBe(0);
  });
});
