// The passkey ceremony's server-side gates. passkeys.test.ts covers the storage
// repo; this covers the plumbing above it — the single-use challenge store and
// the two registration VERIFY endpoints — where the properties live that
// @simplewebauthn can't provide:
//
//   • a challenge is redeemable exactly once (replay protection);
//   • a register-options challenge can't be spent on the signup path, so a
//     signed-in user can't be tricked into minting a second account;
//   • a signup whose credential turns out to be a duplicate rolls its
//     just-created account back, leaving no row nothing can ever sign into;
//   • register-verify only accepts a challenge parked for THE SESSION USER.
//
// The signature check itself is stubbed — that's @simplewebauthn's tested
// territory — so what runs here is exactly the endpoint logic around it, driven
// through real H3 events (body, cookies, headers) the way a request would.

import { eq } from "drizzle-orm";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { SESSION_COOKIE, findOrCreateUser } from "../server/utils/authSession";
import { savePasskey } from "../server/utils/credentialRepo";
import { startChallenge, takeChallenge } from "../server/utils/passkeys";
import registerVerify from "../server/api/auth/passkey/register-verify.post";
import signupVerify from "../server/api/auth/passkey/signup-verify.post";
import { createTestDb, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";
import { makeEvent, setCookieValue } from "./helpers/http";
import { PASSKEY, signInCookie } from "./helpers/session";

// The endpoints reach for useAccountDb() themselves — point it at this file's
// throwaway database.
vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));

// The challenge store and the rate limiter both live in Nitro's `useStorage("kv")`
// auto-import, which doesn't exist under plain vitest — a Map plays the part.
// takeChallenge "deletes" by writing null with a 1s TTL, so a Map read of null is
// exactly the burned-entry answer the real driver gives.
const kv = new Map<string, unknown>();
vi.stubGlobal("useStorage", () => ({
  getItem: async (key: string) => kv.get(key) ?? null,
  setItem: async (key: string, value: unknown) => void kv.set(key, value),
}));

// Stub the signature verification, not the gates around it. Tests that must
// never REACH verification assert this was not called.
vi.mock("@simplewebauthn/server", () => ({ verifyRegistrationResponse: vi.fn() }));
const verifyMock = vi.mocked(verifyRegistrationResponse);
/** What a genuine, verified authenticator response comes back as. */
const verified = (credentialId: string) =>
  ({
    verified: true,
    registrationInfo: {
      credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
    },
  }) as never;

// Keep the suite offline and quiet — the endpoints treat mail as best-effort
// decoration, and canSendEmail() is deliberately true under NODE_ENV=test.
vi.mock("../server/utils/email", () => ({
  canSendEmail: () => false,
  sendMagicLink: vi.fn(),
  sendPasskeyAddedNotice: vi.fn(),
}));

/** The endpoint's request: a JSON body in, the session cookie when signed in. */
const post = (body?: unknown, cookie?: string) => makeEvent("/", { method: "POST", headers: cookie ? { cookie } : {}, body });

const usersWith = (db: TestDb, email: string) =>
  db.select().from(schema.users).where(eq(schema.users.email, email));

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb(ACCOUNT_DDL);
  dbState.db = db;
  kv.clear();
  verifyMock.mockReset();
});

describe("takeChallenge — single use", () => {
  it("returns a parked challenge exactly once, then nothing", async () => {
    const flowId = await startChallenge("chal-1", 7);
    expect(await takeChallenge(flowId)).toMatchObject({ challenge: "chal-1", userId: 7 });
    // the replay: same flow id again finds a burned entry
    expect(await takeChallenge(flowId)).toBeNull();
  });

  it("keeps flows apart — redeeming one leaves the other intact", async () => {
    const a = await startChallenge("chal-a");
    const b = await startChallenge("chal-b");
    expect((await takeChallenge(a))?.challenge).toBe("chal-a");
    expect((await takeChallenge(b))?.challenge).toBe("chal-b");
  });

  it("answers junk with null rather than an error", async () => {
    expect(await takeChallenge("")).toBeNull();
    expect(await takeChallenge("never-issued")).toBeNull();
    expect(await takeChallenge("x".repeat(201))).toBeNull(); // over the length gate
  });
});

describe("signup-verify — minting an account", () => {
  it("creates the account with the address the CHALLENGE carries, and signs it in", async () => {
    const flowId = await startChallenge("chal-s", undefined, "new@example.com");
    verifyMock.mockResolvedValue(verified("cred-a"));

    const event = post({ flowId, response: { some: "attestation" } });
    expect(await signupVerify(event)).toEqual({ ok: true, email: "new@example.com" });

    // origin, RP ID and challenge all came from the server side, never the body
    expect(verifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "chal-s",
        expectedOrigin: "http://mahonia.test",
        expectedRPID: "mahonia.test",
      }),
    );
    expect(await usersWith(db, "new@example.com")).toHaveLength(1);
    expect(await db.select().from(schema.credentials)).toHaveLength(1);
    expect(setCookieValue(event, SESSION_COOKIE)).toBeTruthy();

    // replaying the whole verified response finds no challenge left to match
    const replay = post({ flowId, response: { some: "attestation" } });
    expect(await signupVerify(replay)).toEqual({ ok: false, reason: "expired" });
    expect(await usersWith(db, "new@example.com")).toHaveLength(1);
  });

  it("refuses a register-options challenge — signed-in users can't mint a second account", async () => {
    const me = await findOrCreateUser(db, "ryan@example.com");
    // what register-options parks: a userId, no email
    const flowId = await startChallenge("chal-r", me.id);
    verifyMock.mockResolvedValue(verified("cred-b"));

    const res = await signupVerify(post({ flowId, response: {} }));
    expect(res).toEqual({ ok: false, reason: "expired" });
    // refused at the gate, before any signature math ran
    expect(verifyMock).not.toHaveBeenCalled();
    expect(await db.select().from(schema.users)).toHaveLength(1); // just ryan
  });

  it("refuses a challenge carrying a userId even if an email somehow rides along", async () => {
    const me = await findOrCreateUser(db, "ryan@example.com");
    const flowId = await startChallenge("chal-x", me.id, "other@example.com");

    expect(await signupVerify(post({ flowId, response: {} }))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await usersWith(db, "other@example.com")).toHaveLength(0);
  });

  it("rolls the account back when the credential is already registered — no unreachable row survives", async () => {
    const owner = await findOrCreateUser(db, "owner@example.com");
    await savePasskey(db, { userId: owner.id, credentialId: "cred-dup", ...PASSKEY });

    const flowId = await startChallenge("chal-d", undefined, "second@example.com");
    verifyMock.mockResolvedValue(verified("cred-dup"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const event = post({ flowId, response: {} });
      expect(await signupVerify(event)).toEqual({ ok: false, reason: "invalid" });

      // the account was created and then rolled back — nothing could ever sign
      // into a row whose only credential belongs to someone else
      expect(await usersWith(db, "second@example.com")).toHaveLength(0);
      expect(setCookieValue(event, SESSION_COOKIE)).toBeNull();
      // and the credential still belongs to its rightful owner, exactly once
      const creds = await db.select().from(schema.credentials);
      expect(creds).toHaveLength(1);
      expect(creds[0]!.userId).toBe(owner.id);
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("register-verify — adding a key to a signed-in account", () => {
  let myId: number;
  let cookie: string;
  beforeEach(async () => {
    myId = (await findOrCreateUser(db, "ryan@example.com")).id;
    ({ cookie } = await signInCookie(db, myId));
  });

  it("rejects outright with no session — there is no account to add a key to", async () => {
    await expect(registerVerify(post({}))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("refuses a challenge parked for a DIFFERENT account", async () => {
    const other = await findOrCreateUser(db, "other@example.com");
    const flowId = await startChallenge("chal-o", other.id);
    verifyMock.mockResolvedValue(verified("cred-c"));

    const res = await registerVerify(post({ flowId, response: {} }, cookie));
    expect(res).toEqual({ ok: false, reason: "expired" });
    // refused before verification — the challenge's owner is checked first
    expect(verifyMock).not.toHaveBeenCalled();
    expect(await db.select().from(schema.credentials)).toHaveLength(0);
  });

  it("refuses a signup challenge (no userId) spent on the register path", async () => {
    const flowId = await startChallenge("chal-s", undefined, "new@example.com");

    const res = await registerVerify(post({ flowId, response: {} }, cookie));
    expect(res).toEqual({ ok: false, reason: "expired" });
    expect(await db.select().from(schema.credentials)).toHaveLength(0);
  });

  it("saves the key for the session user when the challenge is theirs", async () => {
    const flowId = await startChallenge("chal-m", myId);
    verifyMock.mockResolvedValue(verified("cred-mine"));

    const res = await registerVerify(
      post({ flowId, response: {}, label: "MacBook" }, cookie),
    );
    expect(res).toEqual({ ok: true });

    const creds = await db.select().from(schema.credentials);
    expect(creds).toHaveLength(1);
    expect(creds[0]!).toMatchObject({ userId: myId, credentialId: "cred-mine", label: "MacBook" });
  });
});
