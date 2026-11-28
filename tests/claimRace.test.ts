// A stranger who signed up with a passkey under someone else's address is evicted
// when the real owner redeems a link (claimUnverifiedAccount). The eviction is four
// separate statements, and every way of making a session, passkey or token checks
// its credential first and writes later, so a request already past its check can
// write a fresh row just after the delete that would have caught it. Each test here
// plays one of those requests in that order (check, claim, write) and shows that the
// straggler it leaves behind opens nothing, while the same steps with no claim in
// between, and the owner's own sign-in after it, still work.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { issueAppTokens, mintAccessToken, refreshAppTokens, resolveBearer } from "../server/utils/accessTokens";
import { SESSION_COOKIE, claimUnverifiedAccount, createAccount, resolveSession, startSession } from "../server/utils/authSession";
import { findCredential, savePasskey } from "../server/utils/credentialRepo";
import { mintAuthCode, redeemAuthCode } from "../server/utils/oauth";
import type { OAuthClient } from "../server/utils/oauthClients";
import { createTestDb, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";
import { makeEvent, setCookieValue } from "./helpers/http";
import { PASSKEY } from "./helpers/session";

// resolveSession reaches for useDb() itself
vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));

const CLIENT: OAuthClient = { clientId: "https://client.example/metadata.json", label: "client.example", redirectUris: ["https://client.example/cb"], kind: "document" };

let db: TestDb;
let accountId: number;

/** A session as startSession writes it, and the user resolveSession reads back from
 *  its cookie (null when the session opens nothing). */
async function sessionFor(userId: number, unproven: boolean) {
  const event = makeEvent("/");
  await startSession(event, db, userId, { sweep: true, unproven });
  const cookie = `${SESSION_COOKIE}=${setCookieValue(event, SESSION_COOKIE)}`;
  return { cookie, read: () => resolveSession(makeEvent("/", { headers: { cookie } })) };
}

beforeEach(async () => {
  db = await createTestDb(ACCOUNT_DDL);
  dbState.db = db;
  // the stranger's passkey signup: the account and the key it leaves on it
  accountId = (await createAccount(db, "owner@example.com")).id;
  await savePasskey(db, { userId: accountId, credentialId: "stranger-key", ...PASSKEY, unproven: true });
});

describe("before anyone proves the address", () => {
  it("lets the passkey-signup account work as it always has", async () => {
    const cred = await findCredential(db, "stranger-key");
    expect(cred?.accountUnproven).toBe(true);
    const session = await sessionFor(accountId, true);
    const user = await session.read();
    expect(user?.unproven).toBe(true);
    const token = await mintAccessToken(db, accountId, { scope: "write", unproven: user!.unproven });
    expect(await resolveBearer(db, token!.token)).toMatchObject({ userId: accountId });
  });
});

describe("a request in flight when the owner's link is redeemed", () => {
  it("passkey sign-in: the session it starts after the claim opens nothing", async () => {
    const cred = await findCredential(db, "stranger-key"); // checked before the claim
    await claimUnverifiedAccount(db, accountId);
    const session = await sessionFor(cred!.userId, cred!.accountUnproven); // written after
    expect(await session.read()).toBeNull();
  });

  it("adding a passkey: the key saved after the claim signs nobody in", async () => {
    const session = await sessionFor(accountId, true);
    const user = await session.read(); // the ceremony's session check
    await claimUnverifiedAccount(db, accountId);
    await savePasskey(db, { userId: accountId, credentialId: "late-key", ...PASSKEY, unproven: user!.unproven });
    expect(await findCredential(db, "late-key")).toBeNull();
  });

  it("minting a token: the token minted after the claim reaches nothing", async () => {
    const user = await (await sessionFor(accountId, true)).read();
    await claimUnverifiedAccount(db, accountId);
    const token = await mintAccessToken(db, accountId, { scope: "write", unproven: user!.unproven });
    expect(token).not.toBeNull();
    expect(await resolveBearer(db, token!.token)).toBeNull();
  });

  it("consent: the code written after the claim trades for a grant that neither works nor refreshes", async () => {
    const user = await (await sessionFor(accountId, true)).read();
    await claimUnverifiedAccount(db, accountId);
    const raw = await mintAuthCode(db, { userId: accountId, client: CLIENT, redirectUri: CLIENT.redirectUris[0]!, codeChallenge: "c", scope: "write", unproven: user!.unproven });
    const code = await redeemAuthCode(db, raw);
    const issued = await issueAppTokens(db, { userId: code!.userId, clientId: code!.clientId, label: code!.clientName, scope: code!.scope, unproven: code!.unproven });
    expect(await resolveBearer(db, issued.access_token)).toBeNull();
    expect(await refreshAppTokens(db, issued.refresh_token, CLIENT.clientId)).toBeNull();
  });
});

describe("the owner, after the claim", () => {
  it("signs in by link, and what that session makes works", async () => {
    await claimUnverifiedAccount(db, accountId);
    const session = await sessionFor(accountId, false); // verify.post: the link is the proof
    const user = await session.read();
    expect(user).toMatchObject({ id: accountId, unproven: false });
    await savePasskey(db, { userId: accountId, credentialId: "owner-key", ...PASSKEY, unproven: user!.unproven });
    expect(await findCredential(db, "owner-key")).toMatchObject({ userId: accountId, accountUnproven: false });
    const token = await mintAccessToken(db, accountId, { scope: "read", unproven: user!.unproven });
    expect(await resolveBearer(db, token!.token)).toMatchObject({ userId: accountId, scope: "read" });
  });
});
