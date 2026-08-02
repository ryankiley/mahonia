import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { LISTS_DDL } from "../server/utils/db";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { claimLists, claimedEditHash, listClaimedLists, unclaimList } from "../server/utils/claimRepo";
import { findByEditHash, findByEditToken, rotateEditHash } from "../server/utils/listRepo";
import { randomEditToken, randomShareCode, sha256Hex } from "../server/utils/tokens";

type DB = ReturnType<typeof drizzle>;
async function freshDb(): Promise<DB> {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of [...LISTS_DDL, ...ACCOUNT_DDL]) await db.execute(sql.raw(stmt));
  return db;
}

// Insert a list directly — createList() reaches for the shared connection, and
// these tests want a throwaway database per case.
async function makeList(db: DB, title = "Sierra trip") {
  const editToken = randomEditToken();
  const shareCode = randomShareCode();
  const rows = await db
    .insert(schema.lists)
    .values({
      publicSlug: `${title.toLowerCase().replace(/\W+/g, "-")}-${shareCode.slice(0, 6).toLowerCase()}`,
      editTokenHash: sha256Hex(editToken),
      shareCode,
      title,
      data: { folders: [], items: [] },
      totalWeightMg: 539_000,
    })
    .returning();
  return { editToken, shareCode, id: rows[0]!.id };
}

describe("claiming a list onto an account", () => {
  let db: DB;
  const USER = 1;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("claims a list the caller can prove they hold", async () => {
    const list = await makeList(db);
    expect(await claimLists(db as any, USER, [list.editToken])).toBe(1);
    const claimed = await listClaimedLists(db as any, USER);
    expect(claimed.map((l) => l.shareCode)).toEqual([list.shareCode]);
  });

  it("is idempotent — re-claiming the same list adds nothing", async () => {
    const list = await makeList(db);
    await claimLists(db as any, USER, [list.editToken]);
    expect(await claimLists(db as any, USER, [list.editToken])).toBe(0);
    expect(await listClaimedLists(db as any, USER)).toHaveLength(1);
  });

  it("silently skips tokens that resolve to nothing", async () => {
    // a device registry accumulates dead entries; a per-token verdict would also
    // let a caller probe for token existence
    const list = await makeList(db);
    const n = await claimLists(db as any, USER, ["not-a-real-token", list.editToken, ""]);
    expect(n).toBe(1);
    expect(await listClaimedLists(db as any, USER)).toHaveLength(1);
  });

  it("stores NO edit token — a dump of the claims yields no capability", async () => {
    const list = await makeList(db);
    await claimLists(db as any, USER, [list.editToken]);
    const rows = await db.select().from(schema.listClaims);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(list.editToken);
    // and nothing the API hands back carries it either
    const claimed = await listClaimedLists(db as any, USER);
    expect(JSON.stringify(claimed)).not.toContain(list.editToken);
  });

  it("lets several accounts hold the same list — an edit link is shared by design", async () => {
    const list = await makeList(db);
    await claimLists(db as any, 1, [list.editToken]);
    await claimLists(db as any, 2, [list.editToken]);
    expect(await listClaimedLists(db as any, 1)).toHaveLength(1);
    expect(await listClaimedLists(db as any, 2)).toHaveLength(1);
  });

  it("drops a soft-deleted list from the claimed set", async () => {
    const list = await makeList(db);
    await claimLists(db as any, USER, [list.editToken]);
    await db
      .update(schema.lists)
      .set({ deletedAt: new Date() })
      .where(sql`id = ${list.id}`);
    expect(await listClaimedLists(db as any, USER)).toHaveLength(0);
  });
});

describe("claimedEditHash — the session's route to the capability", () => {
  let db: DB;
  const USER = 1;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("returns the SAME hash the edit token would resolve to", async () => {
    const list = await makeList(db);
    await claimLists(db as any, USER, [list.editToken]);
    const viaClaim = await claimedEditHash(db as any, USER, list.shareCode);
    expect(viaClaim).toBe(sha256Hex(list.editToken));
    // and it lands on the same row
    expect((await findByEditHash(viaClaim!, db as any))!.id).toBe(list.id);
    expect((await findByEditToken(list.editToken, db as any))!.id).toBe(list.id);
  });

  it("survives a rotated edit token — the hash is re-read, never cached", async () => {
    const list = await makeList(db);
    await claimLists(db as any, USER, [list.editToken]);
    const next = randomEditToken();
    await db
      .update(schema.lists)
      .set({ editTokenHash: sha256Hex(next) })
      .where(sql`id = ${list.id}`);
    expect(await claimedEditHash(db as any, USER, list.shareCode)).toBe(sha256Hex(next));
  });

  it("refuses a share code this account hasn't claimed", async () => {
    const list = await makeList(db);
    // the share code is PUBLIC, so this is the case that matters: knowing it must
    // not be enough to get write access
    expect(await claimedEditHash(db as any, USER, list.shareCode)).toBeNull();
    await claimLists(db as any, 2, [list.editToken]);
    expect(await claimedEditHash(db as any, USER, list.shareCode)).toBeNull();
    expect(await claimedEditHash(db as any, 2, list.shareCode)).not.toBeNull();
  });

  it("is case-insensitive on the code and rejects a malformed one", async () => {
    const list = await makeList(db);
    await claimLists(db as any, USER, [list.editToken]);
    expect(await claimedEditHash(db as any, USER, list.shareCode.toLowerCase())).not.toBeNull();
    expect(await claimedEditHash(db as any, USER, "nope")).toBeNull();
    expect(await claimedEditHash(db as any, USER, "'; drop table lists; --")).toBeNull();
  });

  it("stops resolving once the list is soft-deleted", async () => {
    const list = await makeList(db);
    await claimLists(db as any, USER, [list.editToken]);
    await db.update(schema.lists).set({ deletedAt: new Date() }).where(sql`id = ${list.id}`);
    expect(await claimedEditHash(db as any, USER, list.shareCode)).toBeNull();
  });
});

describe("unclaiming", () => {
  let db: DB;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("detaches from the account but leaves the list alone", async () => {
    const list = await makeList(db);
    await claimLists(db as any, 1, [list.editToken]);
    expect(await unclaimList(db as any, 1, list.shareCode)).toBe(true);
    expect(await listClaimedLists(db as any, 1)).toHaveLength(0);
    // the list itself is untouched — the edit link still works
    expect(await findByEditToken(list.editToken, db as any)).not.toBeNull();
  });

  it("can't unclaim another account's hold on the same list", async () => {
    const list = await makeList(db);
    await claimLists(db as any, 1, [list.editToken]);
    await claimLists(db as any, 2, [list.editToken]);
    expect(await unclaimList(db as any, 2, list.shareCode)).toBe(true);
    // user 1 still holds it
    expect(await listClaimedLists(db as any, 1)).toHaveLength(1);
  });
});

describe("rotation revokes claim-based access", () => {
  let db: DB;
  const OWNER = 1;
  const GUEST = 2;
  beforeEach(async () => {
    db = await freshDb();
  });

  const rotate = (editHash: string, keepUserId?: number) =>
    rotateEditHash(editHash, keepUserId, db as never);

  it("drops another account's claim, so a leaked link can actually be revoked", async () => {
    const list = await makeList(db);
    await db.update(schema.lists).set({ authorUserId: OWNER }).where(sql`id = ${list.id}`);
    await claimLists(db as any, OWNER, [list.editToken]);
    await claimLists(db as any, GUEST, [list.editToken]);

    // the owner rotates to cut off the link they shared
    expect(await rotate(sha256Hex(list.editToken), OWNER)).toBeTruthy();

    // the guest's session no longer authorises anything on this list …
    expect(await claimedEditHash(db as any, GUEST, list.shareCode)).toBeNull();
    expect(await listClaimedLists(db as any, GUEST)).toHaveLength(0);
    // … while the owner keeps theirs
    expect(await claimedEditHash(db as any, OWNER, list.shareCode)).not.toBeNull();
  });

  it("keeps the CREATOR's claim when a link-holder rotates", async () => {
    // otherwise someone handed a link could rotate and strip the author's access
    const list = await makeList(db);
    await db.update(schema.lists).set({ authorUserId: OWNER }).where(sql`id = ${list.id}`);
    await claimLists(db as any, OWNER, [list.editToken]);
    await claimLists(db as any, GUEST, [list.editToken]);

    await rotate(sha256Hex(list.editToken), GUEST);

    expect(await claimedEditHash(db as any, OWNER, list.shareCode)).not.toBeNull();
  });

  it("clears every claim when an anonymous link-holder rotates", async () => {
    const list = await makeList(db); // no authorUserId — made without an account
    await claimLists(db as any, GUEST, [list.editToken]);
    await rotate(sha256Hex(list.editToken));
    expect(await listClaimedLists(db as any, GUEST)).toHaveLength(0);
  });

  it("re-points a surviving claim at the NEW token hash", async () => {
    const list = await makeList(db);
    await claimLists(db as any, OWNER, [list.editToken]);
    const next = await rotate(sha256Hex(list.editToken), OWNER);
    expect(await claimedEditHash(db as any, OWNER, list.shareCode)).toBe(sha256Hex(next!));
  });
});
