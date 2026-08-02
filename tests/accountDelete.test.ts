// Closing an account — the only operation in the app that destroys data across
// several tables at once, and the only one with no undo.
//
// The rule that matters most is the one about LISTS, and it's the one easiest to
// get wrong: a list belongs to its edit link, not to the account that bookmarked
// it, so closing an account must leave every list exactly where it was unless
// asked otherwise. Getting that backwards would take lists away from people who
// still hold working links to them — including anyone they'd shared with.
//
// Driven directly against a throwaway database rather than through the route: an
// in-process test is the only way to assert on the rows afterwards. (Learned the
// hard way — checking this through a running dev server meant two processes with
// the same PGlite directory open, and the two views disagreed.)

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { LISTS_DDL } from "../server/utils/db";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { deleteAccount } from "../server/utils/accountRepo";
import { claimLists } from "../server/utils/claimRepo";
import { randomEditToken, randomShareCode, sha256Hex } from "../server/utils/tokens";

type DB = ReturnType<typeof drizzle>;
async function freshDb(): Promise<DB> {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of [...LISTS_DDL, ...ACCOUNT_DDL, ...VAULT_DDL]) await db.execute(sql.raw(stmt));
  return db;
}

async function makeUser(db: DB, email: string): Promise<number> {
  const rows = await db.insert(schema.users).values({ email }).returning();
  return rows[0]!.id;
}

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
    })
    .returning();
  return { editToken, shareCode, id: rows[0]!.id };
}

/** A vault with one folder and one piece of gear in it. */
async function makeVault(db: DB, userId: number): Promise<number> {
  const v = await db.insert(schema.vaults).values({ userId }).returning();
  const vaultId = v[0]!.id;
  const f = await db.insert(schema.vaultFolders).values({ vaultId, name: "Shelter" }).returning();
  await db.insert(schema.vaultItems).values({
    vaultId,
    normKey: "tent-x",
    name: "Tent X",
    weightMg: 900_000,
    folderId: f[0]!.id,
  });
  return vaultId;
}

const count = async (db: DB, table: string, where: string): Promise<number> => {
  const r = await db.execute(sql.raw(`select count(*)::int as n from ${table} where ${where}`));
  return Number((r as unknown as { rows: { n: number }[] }).rows[0]!.n);
};

describe("closing an account", () => {
  let db: DB;
  let user: number;
  beforeEach(async () => {
    db = await freshDb();
    user = await makeUser(db, "ryan@example.com");
  });

  it("removes the account and everything only it owned", async () => {
    const vaultId = await makeVault(db, user);
    await db.insert(schema.sessions).values({
      tokenHash: "sess-hash",
      userId: user,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db.insert(schema.authTokens).values({
      tokenHash: "link-hash",
      userId: user,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db.insert(schema.credentials).values({
      userId: user,
      credentialId: "cred-1",
      publicKey: "pk",
    });

    const res = await deleteAccount(db as never, user);
    expect(res.vaultDeleted).toBe(true);

    expect(await count(db, "users", `id = ${user}`)).toBe(0);
    expect(await count(db, "sessions", `user_id = ${user}`)).toBe(0);
    expect(await count(db, "auth_tokens", `user_id = ${user}`)).toBe(0);
    expect(await count(db, "credentials", `user_id = ${user}`)).toBe(0);
    // the vault goes with its contents — no orphaned items pointing at a vault
    // nothing can reach
    expect(await count(db, "vaults", `id = ${vaultId}`)).toBe(0);
    expect(await count(db, "vault_items", `vault_id = ${vaultId}`)).toBe(0);
    expect(await count(db, "vault_folders", `vault_id = ${vaultId}`)).toBe(0);
  });

  it("LEAVES THE LISTS ALONE by default, and only drops the claim", async () => {
    const list = await makeList(db);
    await claimLists(db as never, user, [list.editToken]);

    const res = await deleteAccount(db as never, user);
    expect(res.listsDeleted).toBe(0);

    // the bookmark is gone...
    expect(await count(db, "list_claims", `user_id = ${user}`)).toBe(0);
    // ...and the list is untouched, still open to anyone holding the link
    expect(await count(db, "lists", `id = ${list.id} and deleted_at is null`)).toBe(1);
  });

  it("deletes the claimed lists when that is explicitly asked for", async () => {
    const mine = await makeList(db, "Mine");
    await claimLists(db as never, user, [mine.editToken]);

    const res = await deleteAccount(db as never, user, { deleteLists: true });
    expect(res.listsDeleted).toBe(1);
    // soft-delete, like the owner pressing Delete — the nightly purge reclaims it
    expect(await count(db, "lists", `id = ${mine.id} and deleted_at is not null`)).toBe(1);
  });

  it("never touches a list this account didn't claim, even when deleting lists", async () => {
    const mine = await makeList(db, "Mine");
    const someoneElses = await makeList(db, "Not mine");
    await claimLists(db as never, user, [mine.editToken]);

    await deleteAccount(db as never, user, { deleteLists: true });
    expect(await count(db, "lists", `id = ${someoneElses.id} and deleted_at is null`)).toBe(1);
  });

  it("clears the byline rather than leaving it pointing at a deleted account", async () => {
    const list = await makeList(db);
    await db.execute(sql.raw(`update lists set author_user_id = ${user} where id = ${list.id}`));

    await deleteAccount(db as never, user);
    // `users.id` is a serial, so a later account could inherit this id — a stale
    // byline would put a stranger's name on someone else's list
    expect(await count(db, "lists", `id = ${list.id} and author_user_id is null`)).toBe(1);
  });

  it("leaves another account's vault and claims entirely alone", async () => {
    const other = await makeUser(db, "someone@example.com");
    const otherVault = await makeVault(db, other);
    const theirList = await makeList(db, "Theirs");
    await claimLists(db as never, other, [theirList.editToken]);

    await makeVault(db, user);
    await deleteAccount(db as never, user, { deleteLists: true });

    expect(await count(db, "users", `id = ${other}`)).toBe(1);
    expect(await count(db, "vaults", `id = ${otherVault}`)).toBe(1);
    expect(await count(db, "vault_items", `vault_id = ${otherVault}`)).toBe(1);
    expect(await count(db, "list_claims", `user_id = ${other}`)).toBe(1);
    expect(await count(db, "lists", `id = ${theirList.id} and deleted_at is null`)).toBe(1);
  });

  it("is safe on an account with no vault, no claims and no passkeys", async () => {
    const res = await deleteAccount(db as never, user);
    expect(res).toEqual({ listsDeleted: 0, vaultDeleted: false });
    expect(await count(db, "users", `id = ${user}`)).toBe(0);
  });
});
