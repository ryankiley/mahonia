// The edit endpoints' ONE gate (server/utils/editAuth.requireEditHash), exercised
// as a request would hit it — a real H3 event over bare node mocks, no server
// booted (the pattern sessionLifecycle.test.ts established). The repo layers on
// either side have their own suites (claims.test.ts for claimedEditHash,
// editByClaim.test.ts for the hash cores); what lives ONLY at this layer, and is
// pinned here:
//   • which of the two capabilities wins when both are presented;
//   • that every refusal is the same bare 401 — a session naming an unclaimed
//     code must be indistinguishable from no credential at all (no oracle);
//   • that the bearer path never touches the database.

import { sql } from "drizzle-orm";
import type { H3Event } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import { LISTS_DDL } from "../server/utils/db";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { requireEditHash } from "../server/utils/editAuth";
import { findOrCreateUser } from "../server/utils/authSession";
import { claimLists } from "../server/utils/claimRepo";
import { sha256Hex } from "../server/utils/tokens";
import { LIST_CODE_HEADER } from "../shared/links";
import { createTestDb, makeList, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";
import { makeEvent } from "./helpers/http";
import { signInCookie } from "./helpers/session";

// requireEditHash reaches for useVaultDb() and (via resolveSession) useAccountDb();
// point both at this file's throwaway database. `throwIfTouched` lets the bearer
// test prove its path costs no lookup at all.
vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));

/** A request at the gate with these headers and nothing else. */
const gate = (headers: Record<string, string> = {}) => makeEvent("/api/edit/mutate", { method: "POST", headers });

const CODE = "TESTC0DE0001"; // canonical Crockford — normalizes to itself

const seedList = (db: TestDb, shareCode = CODE) => makeList(db, "Gate list", { shareCode });

/** Sign a user in and hand back the cookie header a browser would replay. */
async function signedInCookie(db: TestDb, email: string): Promise<{ userId: number; cookie: string }> {
  const userId = (await findOrCreateUser(db, email)).id;
  return { userId, cookie: (await signInCookie(db, userId)).cookie };
}

/** The refusal, captured whole — the no-oracle cases assert BYTE-equality on it. */
async function refusalOf(event: H3Event): Promise<{ statusCode: number; statusMessage?: string }> {
  try {
    await requireEditHash(event);
  } catch (e) {
    const err = e as { statusCode: number; statusMessage?: string };
    return { statusCode: err.statusCode, statusMessage: err.statusMessage };
  }
  throw new Error("expected requireEditHash to refuse");
}

describe("requireEditHash — one gate, two ways through it", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb(LISTS_DDL, ACCOUNT_DDL);
    dbState.db = db;
    dbState.throwIfTouched = false;
  });

  it("bearer token → its hash, with no database lookup at all", async () => {
    dbState.throwIfTouched = true;
    const hash = await requireEditHash(gate({ authorization: "Bearer tok-abc" }));
    expect(hash).toBe(sha256Hex("tok-abc"));
  });

  it("session + claimed code → the same hash the token path would produce", async () => {
    const list = await seedList(db);
    const { userId, cookie } = await signedInCookie(db, "ryan@example.com");
    await claimLists(db, userId, [list.editToken]);

    const hash = await requireEditHash(gate({ cookie, [LIST_CODE_HEADER]: CODE }));
    expect(hash).toBe(sha256Hex(list.editToken));
  });

  it("normalizes the code's case and confusables on the way in", async () => {
    const list = await seedList(db);
    const { userId, cookie } = await signedInCookie(db, "ryan@example.com");
    await claimLists(db, userId, [list.editToken]);

    // lowercase, with O standing in for 0 — a hand-typed header
    const sloppy = CODE.toLowerCase().replace(/0/g, "o");
    const hash = await requireEditHash(gate({ cookie, [LIST_CODE_HEADER]: sloppy }));
    expect(hash).toBe(sha256Hex(list.editToken));
  });

  it("the token wins when both are presented — a claim can never hijack a link open", async () => {
    // the session holds a claim on list B; the request carries list A's token.
    // The A hash must come back: /e/{codeB}#{tokenA} means list A, signed in or not.
    const a = await seedList(db, "AAAA0000AAAA");
    const b = await seedList(db, "BBBB0000BBBB");
    const { userId, cookie } = await signedInCookie(db, "ryan@example.com");
    await claimLists(db, userId, [b.editToken]);

    const hash = await requireEditHash(
      gate({ cookie, authorization: `Bearer ${a.editToken}`, [LIST_CODE_HEADER]: b.shareCode }),
    );
    expect(hash).toBe(sha256Hex(a.editToken));
  });

  it("refuses a code the session never claimed — identically to no credential", async () => {
    await seedList(db); // the list exists; this session just holds no claim on it
    const { cookie } = await signedInCookie(db, "stranger@example.com");

    const noClaim = await refusalOf(gate({ cookie, [LIST_CODE_HEADER]: CODE }));
    const nothing = await refusalOf(gate());
    expect(noClaim.statusCode).toBe(401);
    // BYTE-equal refusals: a 403, or a different message, would confirm the list
    // exists to anyone probing codes with a valid session
    expect(noClaim).toEqual(nothing);
  });

  it("refuses a claimed code once the list is gone — same bare 401 again", async () => {
    const list = await seedList(db);
    const { userId, cookie } = await signedInCookie(db, "ryan@example.com");
    await claimLists(db, userId, [list.editToken]);
    await db
      .update(schema.lists)
      .set({ deletedAt: new Date() })
      .where(sql`share_code = ${CODE}`);

    const gone = await refusalOf(gate({ cookie, [LIST_CODE_HEADER]: CODE }));
    expect(gone).toEqual(await refusalOf(gate()));
  });

  it("refuses a code with no session behind it", async () => {
    const list = await seedList(db);
    const { userId } = await signedInCookie(db, "ryan@example.com");
    await claimLists(db, userId, [list.editToken]);

    // header present, cookie absent — the code alone is the PUBLIC read handle
    // and must buy nothing here
    const bare = await refusalOf(gate({ [LIST_CODE_HEADER]: CODE }));
    expect(bare.statusCode).toBe(401);
  });
});
