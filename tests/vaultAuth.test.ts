// The vault's identity layer.
//
// A vault belongs to an ACCOUNT — unlike a list, which belongs to whoever holds its
// edit link. What has to hold, and is pinned here:
//   • one vault per account, enforced by the index rather than by the caller;
//   • an account with no vault resolves to nothing, rather than getting a fresh one;
//   • one vault can never read or write another's rows, whatever id it names.
//
// The repo-layer scoping is the part worth the most attention: an id from another
// vault has to match NOTHING, not "match and then get filtered", because the second
// shape is the one that quietly stops being true when someone adds a query.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { vaults } from "../server/db/schema";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { mintVault, touchVaultByUser } from "../server/utils/vaultAuth";
import {
  applyVaultFolderOp,
  captureVaultItems,
  listVaultFolders,
  listVaultItems,
  reapAbandonedVaults,
  removeVaultItem,
} from "../server/utils/vaultRepo";
import { vaultNormKey } from "../shared/vault";
import { createTestDb } from "./helpers/db";

type DB = ReturnType<typeof drizzle>;

async function freshDb(): Promise<DB> {
  return createTestDb(VAULT_DDL);
}

// The mint/resolve pair, exercised at the DB layer. requireVault() itself takes an
// H3Event and is a thin wrapper over exactly this — booting a server to assert a
// WHERE clause would test the framework, not the rule.
//
// Account ids are just integers here; the tests never create `users` rows, because
// nothing in the vault path reads one. That's a property worth keeping: the vault
// depends on WHICH account, never on anything about it.
async function mint(db: DB, userId: number): Promise<number> {
  const rows = await db.insert(vaults).values({ userId }).returning();
  return rows[0]!.id;
}
async function resolve(db: DB, userId: number): Promise<number | null> {
  const rows = await db.select().from(vaults).where(sql`user_id = ${userId}`).limit(1);
  return rows[0]?.id ?? null;
}

const cap = (name: string, over: Record<string, unknown> = {}) =>
  ({
    normKey: vaultNormKey(null, name, null),
    name,
    weightMg: 100_000,
    ...over,
  }) as never;

describe("vault ownership", () => {
  let db: DB;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("holds no secret — the row grants nothing to whoever reads it", async () => {
    const id = await mint(db, 1);

    const rows = await db.select().from(vaults);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    // The point of the move off link-ownership: there is no capability in this row
    // at all. Under the old shape a database dump carried the sha256 of every
    // vault's token; now it carries an owner id and nothing else.
    expect(Object.keys(rows[0]!)).not.toContain("tokenHash");
    expect(JSON.stringify(rows[0])).not.toMatch(/token/i);
  });

  it("resolves an account's vault and nobody else's", async () => {
    const id = await mint(db, 1);
    expect(await resolve(db, 1)).toBe(id);
    expect(await resolve(db, 2)).toBeNull();
  });

  it("gives distinct accounts distinct vaults", async () => {
    expect(await mint(db, 1)).not.toBe(await mint(db, 2));
  });

  it("refuses a second vault for the same account", async () => {
    await mint(db, 1);
    // the unique index, not the caller — mintVault leans on exactly this to stay
    // safe when two captures race
    await expect(mint(db, 1)).rejects.toThrow();
  });

  it("mintVault survives losing that race instead of throwing", async () => {
    const first = await mint(db, 7);
    // the loser's insert is swallowed by onConflictDoNothing and it re-reads the
    // winner's row, so an account can never end up with two vaults OR with none
    expect(await mintVault(db as never, 7)).toBe(first);
  });
});

describe("vault isolation — one vault can never reach another's gear", () => {
  let db: DB;
  let mine: number;
  let theirs: number;
  beforeEach(async () => {
    db = await freshDb();
    mine = await mint(db, 1);
    theirs = await mint(db, 2);
  });

  it("keeps captures apart even when the gear is identical", async () => {
    await captureVaultItems(db as never, mine, [cap("Duplex")]);
    await captureVaultItems(db as never, theirs, [cap("Duplex")]);

    // same norm_key, two rows — the unique index is (vault_id, norm_key), so one
    // person's tent can't collide with another's
    expect(await listVaultItems(db as never, mine)).toHaveLength(1);
    expect(await listVaultItems(db as never, theirs)).toHaveLength(1);
  });

  it("does not list another vault's rows", async () => {
    await captureVaultItems(db as never, theirs, [cap("Quilt")]);
    expect(await listVaultItems(db as never, mine)).toHaveLength(0);
  });

  it("refuses to remove a row belonging to another vault", async () => {
    await captureVaultItems(db as never, theirs, [cap("Quilt")]);
    const row = (await listVaultItems(db as never, theirs))[0]!;

    // naming their row id from my vault matches nothing — the same answer as an id
    // that doesn't exist, so the endpoint never confirms their row is real
    expect(await removeVaultItem(db as never, mine, row.id)).toBe(false);
    expect(await listVaultItems(db as never, theirs)).toHaveLength(1);
  });

  it("scopes a removal to the vault that asked for it", async () => {
    await captureVaultItems(db as never, mine, [cap("Duplex")]);
    await captureVaultItems(db as never, theirs, [cap("Duplex")]);
    const row = (await listVaultItems(db as never, mine))[0]!;

    expect(await removeVaultItem(db as never, mine, row.id)).toBe(true);
    expect(await listVaultItems(db as never, mine)).toHaveLength(0);
    // theirs is untouched, though the gear is identical
    expect(await listVaultItems(db as never, theirs)).toHaveLength(1);
  });

  // Folders are a second id space over the same vault, so every folder verb needs
  // the same scoping the row verbs have — and the "move" op needs it TWICE, since
  // it names an item id and a folder id in one call.
  it("refuses to rename, re-sort or delete another vault's folder", async () => {
    await applyVaultFolderOp(db as never, theirs, { t: "add", name: "Shelter" });
    const [theirFolder] = await listVaultFolders(db as never, theirs);

    expect(await applyVaultFolderOp(db as never, mine, { t: "rename", id: theirFolder!.id, name: "hax" })).toBe(false);
    expect(await applyVaultFolderOp(db as never, mine, { t: "sort", id: theirFolder!.id, sortBy: "name" })).toBe(false);
    expect(await applyVaultFolderOp(db as never, mine, { t: "remove", id: theirFolder!.id })).toBe(false);

    // untouched, and still named what they named it
    const after = await listVaultFolders(db as never, theirs);
    expect(after).toHaveLength(1);
    expect(after[0]!.name).toBe("Shelter");
    expect(after[0]!.sortBy).toBeUndefined();
  });

  it("won't file my gear into another vault's folder", async () => {
    await applyVaultFolderOp(db as never, theirs, { t: "add", name: "Theirs" });
    const [theirFolder] = await listVaultFolders(db as never, theirs);
    await captureVaultItems(db as never, mine, [cap("Duplex")]);
    const row = (await listVaultItems(db as never, mine))[0]!;

    // the folder id is verified in MY scope before it's written — otherwise gear
    // would end up filed under a heading its owner can never see
    expect(await applyVaultFolderOp(db as never, mine, { t: "move", itemId: row.id, folderId: theirFolder!.id })).toBe(false);
    expect((await listVaultItems(db as never, mine))[0]!.folderId).toBeUndefined();
  });

  it("won't move another vault's gear, even into a folder I own", async () => {
    await applyVaultFolderOp(db as never, mine, { t: "add", name: "Mine" });
    const [myFolder] = await listVaultFolders(db as never, mine);
    await captureVaultItems(db as never, theirs, [cap("Quilt")]);
    const theirRow = (await listVaultItems(db as never, theirs))[0]!;

    expect(await applyVaultFolderOp(db as never, mine, { t: "move", itemId: theirRow.id, folderId: myFolder!.id })).toBe(false);
    expect((await listVaultItems(db as never, theirs))[0]!.folderId).toBeUndefined();
  });

  it("reorders only my folders, whatever ids the payload names", async () => {
    await applyVaultFolderOp(db as never, mine, { t: "add", name: "A" });
    await applyVaultFolderOp(db as never, mine, { t: "add", name: "B" });
    await applyVaultFolderOp(db as never, theirs, { t: "add", name: "Theirs" });
    const mineIds = (await listVaultFolders(db as never, mine)).map((f) => f.id);
    const [theirFolder] = await listVaultFolders(db as never, theirs);

    // their id ridden along in the array is simply ignored — it matches nothing in
    // my scope, rather than reordering a folder I don't own
    await applyVaultFolderOp(db as never, mine, {
      t: "reorder",
      ids: [mineIds[1]!, theirFolder!.id, mineIds[0]!],
    });
    expect((await listVaultFolders(db as never, mine)).map((f) => f.name)).toEqual(["B", "A"]);
    expect((await listVaultFolders(db as never, theirs)).map((f) => f.name)).toEqual(["Theirs"]);
  });
});

// The safety net under the nightly reaper. Vaults are reaped by AGE, and there's no
// account and no email behind one — so the reap is a soft-delete, and coming back
// has to be enough to undo it. If this stops holding, the reaper quietly becomes a
// way to lose a vault you still had the link to.
describe("vault revive — a reaped vault comes back by being used", () => {
  let db: DB;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("clears the soft-delete on the next request that resolves the vault", async () => {
    const id = await mint(db, 1);
    await db.update(vaults).set({ deletedAt: new Date() }).where(sql`id = ${id}`);

    expect(await touchVaultByUser(db as never, 1)).toBe(id);
    const [row] = await db.select().from(vaults).where(sql`id = ${id}`);
    expect(row!.deletedAt).toBeNull();
  });

  it("bumps last_seen_at, which is what keeps a live vault out of the reaper", async () => {
    const id = await mint(db, 1);
    await db.update(vaults).set({ lastSeenAt: new Date(Date.now() - 300 * 86_400_000) }).where(sql`id = ${id}`);

    await touchVaultByUser(db as never, 1);
    expect(await reapAbandonedVaults(db as any)).toEqual({ vaultsReaped: 0 });
  });

  it("still resolves nothing for an account that has no vault", async () => {
    await mint(db, 1);
    expect(await touchVaultByUser(db as never, 2)).toBeNull();
  });
});
