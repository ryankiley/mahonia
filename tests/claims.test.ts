import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { LISTS_DDL } from "../server/utils/db";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import {
  claimLists,
  claimedEditHash,
  listClaimedLists,
} from "../server/utils/claimRepo";
import { findByEditHash, rotateEditHash } from "../server/utils/listRepo";
import { randomEditToken, sha256Hex } from "../server/utils/tokens";
import { CLAIMED_LIST_CAP } from "../shared/types";
import { byToken, createTestDb, makeList as makeListRow, makeLists, type TestDb } from "./helpers/db";

const findByEditToken = byToken(findByEditHash);

// A list with a weight, so claimed rows have a figure to show. `extra` forwards to
// the insert — the claim rule reads `createdAt`, so tests need to set it.
const WEIGHED = { totalWeightMg: 539_000 };
const makeList = (
  db: TestDb,
  title = "Sierra trip",
  extra: Partial<typeof schema.lists.$inferInsert> = {},
) => makeListRow(db, title, { ...WEIGHED, ...extra });

let db: TestDb;
beforeEach(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL);
});

describe("claiming a list onto an account", () => {
  const USER = 1;

  it("claims a list the caller can prove they hold", async () => {
    const list = await makeList(db);
    expect(await claimLists(db, USER, [list.editToken])).toBe(1);
    const claimed = await listClaimedLists(db, USER);
    expect(claimed.map((l) => l.shareCode)).toEqual([list.shareCode]);
  });

  it("is idempotent — re-claiming the same list adds nothing", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);
    expect(await claimLists(db, USER, [list.editToken])).toBe(0);
    expect(await listClaimedLists(db, USER)).toHaveLength(1);
  });

  it("silently skips tokens that resolve to nothing", async () => {
    // a device registry accumulates dead entries; a per-token verdict would also
    // let a caller probe for token existence
    const list = await makeList(db);
    const n = await claimLists(db, USER, ["not-a-real-token", list.editToken, ""]);
    expect(n).toBe(1);
    expect(await listClaimedLists(db, USER)).toHaveLength(1);
  });

  it("claims at most CLAIMED_LIST_CAP lists in one call", async () => {
    const titles = Array.from({ length: CLAIMED_LIST_CAP + 1 }, (_, i) => `L${i}`);
    const tokens = (await makeLists(db, titles, WEIGHED)).map((l) => l.editToken);
    expect(await claimLists(db, USER, tokens)).toBe(CLAIMED_LIST_CAP);
    expect(await listClaimedLists(db, USER)).toHaveLength(CLAIMED_LIST_CAP);
  });

  it("stores NO edit token — a dump of the claims yields no capability", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);
    const rows = await db.select().from(schema.listClaims);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(list.editToken);
    // and nothing the API hands back carries it either
    const claimed = await listClaimedLists(db, USER);
    expect(JSON.stringify(claimed)).not.toContain(list.editToken);
  });

  it("lets several accounts hold the same list — an edit link is shared by design", async () => {
    const list = await makeList(db);
    await claimLists(db, 1, [list.editToken]);
    await claimLists(db, 2, [list.editToken]);
    expect(await listClaimedLists(db, 1)).toHaveLength(1);
    expect(await listClaimedLists(db, 2)).toHaveLength(1);
  });

  it("drops a soft-deleted list from the claimed set", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);
    await db
      .update(schema.lists)
      .set({ deletedAt: new Date() })
      .where(sql`id = ${list.id}`);
    expect(await listClaimedLists(db, USER)).toHaveLength(0);
  });
});

describe("claimedEditHash — the session's route to the capability", () => {
  const USER = 1;

  it("returns the SAME hash the edit token would resolve to", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);
    const viaClaim = await claimedEditHash(db, USER, list.shareCode);
    expect(viaClaim).toBe(sha256Hex(list.editToken));
    // and it lands on the same row
    expect((await findByEditHash(viaClaim!, db))!.id).toBe(list.id);
    expect((await findByEditToken(list.editToken, db))!.id).toBe(list.id);
  });

  it("survives a rotated edit token — the hash is re-read, never cached", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);
    const next = randomEditToken();
    await db
      .update(schema.lists)
      .set({ editTokenHash: sha256Hex(next) })
      .where(sql`id = ${list.id}`);
    expect(await claimedEditHash(db, USER, list.shareCode)).toBe(sha256Hex(next));
  });

  it("refuses a share code this account hasn't claimed", async () => {
    const list = await makeList(db);
    // the share code is PUBLIC, so this is the case that matters: knowing it must
    // not be enough to get write access
    expect(await claimedEditHash(db, USER, list.shareCode)).toBeNull();
    await claimLists(db, 2, [list.editToken]);
    expect(await claimedEditHash(db, USER, list.shareCode)).toBeNull();
    expect(await claimedEditHash(db, 2, list.shareCode)).not.toBeNull();
  });

  it("is case-insensitive on the code and rejects a malformed one", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);
    expect(await claimedEditHash(db, USER, list.shareCode.toLowerCase())).not.toBeNull();
    expect(await claimedEditHash(db, USER, "nope")).toBeNull();
    expect(await claimedEditHash(db, USER, "'; drop table lists; --")).toBeNull();
  });

  it("stops resolving once the list is soft-deleted", async () => {
    const list = await makeList(db);
    await claimLists(db, USER, [list.editToken]);
    await db.update(schema.lists).set({ deletedAt: new Date() }).where(sql`id = ${list.id}`);
    expect(await claimedEditHash(db, USER, list.shareCode)).toBeNull();
  });
});

describe("rotation revokes claim-based access", () => {
  const OWNER = 1;
  const GUEST = 2;

  const rotate = (editHash: string, keepUserId?: number) =>
    rotateEditHash(editHash, keepUserId, db);

  it("drops another account's claim, so a leaked link can actually be revoked", async () => {
    const list = await makeList(db);
    await db.update(schema.lists).set({ authorUserId: OWNER }).where(sql`id = ${list.id}`);
    await claimLists(db, OWNER, [list.editToken]);
    await claimLists(db, GUEST, [list.editToken]);

    // the owner rotates to cut off the link they shared
    expect(await rotate(sha256Hex(list.editToken), OWNER)).toBeTruthy();

    // the guest's session no longer authorises anything on this list …
    expect(await claimedEditHash(db, GUEST, list.shareCode)).toBeNull();
    expect(await listClaimedLists(db, GUEST)).toHaveLength(0);
    // … while the owner keeps theirs
    expect(await claimedEditHash(db, OWNER, list.shareCode)).not.toBeNull();
  });

  it("keeps the CREATOR's claim when a link-holder rotates", async () => {
    // otherwise someone handed a link could rotate and strip the author's access
    const list = await makeList(db);
    await db.update(schema.lists).set({ authorUserId: OWNER }).where(sql`id = ${list.id}`);
    await claimLists(db, OWNER, [list.editToken]);
    await claimLists(db, GUEST, [list.editToken]);

    await rotate(sha256Hex(list.editToken), GUEST);

    expect(await claimedEditHash(db, OWNER, list.shareCode)).not.toBeNull();
  });

  it("clears every claim when an anonymous link-holder rotates", async () => {
    const list = await makeList(db); // no authorUserId — made without an account
    await claimLists(db, GUEST, [list.editToken]);
    await rotate(sha256Hex(list.editToken));
    expect(await listClaimedLists(db, GUEST)).toHaveLength(0);
  });

  it("re-points a surviving claim at the NEW token hash", async () => {
    const list = await makeList(db);
    await claimLists(db, OWNER, [list.editToken]);
    const next = await rotate(sha256Hex(list.editToken), OWNER);
    expect(await claimedEditHash(db, OWNER, list.shareCode)).toBe(sha256Hex(next!));
  });
});
