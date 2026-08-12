// Rebuilding a vault from the lists an account holds — the sign-in path.
//
// This exists because of a bug that shipped through typecheck and review:
// `backfillVaultFromClaims(db, userId)` passed its userId straight into
// `captureVaultItems(db, vaultId, …)`. Both parameters are plain `number`, and
// `vault_items` has no foreign key on `vault_id`, so the rows were written to
// whatever vault happened to share that id — another account's, or a phantom.
// The one caller wraps it in `.catch()`, so it also failed silently.
//
// The test that matters is therefore not "does it write rows" but "does it write
// them to the RIGHT vault, and to nobody else's". Nothing here asserts a row count
// without also asserting whose vault it landed in.

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { LISTS_DDL } from "../server/utils/db";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { backfillVaultFromClaims, claimLists } from "../server/utils/claimRepo";
import { applyVaultItemOp, listVaultItems } from "../server/utils/vaultRepo";
import { randomEditToken, randomShareCode, sha256Hex } from "../server/utils/tokens";
import { createTestDb } from "./helpers/db";

type DB = ReturnType<typeof drizzle>;
async function freshDb(): Promise<DB> {
  return createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL);
}

async function makeUser(db: DB, email: string): Promise<number> {
  const rows = await db.insert(schema.users).values({ email }).returning();
  return rows[0]!.id;
}

/** A list carrying one named piece of gear, so the backfill has something to fold. */
async function makeListWithGear(db: DB, title: string, gear: string) {
  const editToken = randomEditToken();
  const shareCode = randomShareCode();
  const rows = await db
    .insert(schema.lists)
    .values({
      publicSlug: `${gear.toLowerCase().replace(/\W+/g, "-")}-${shareCode.slice(0, 6).toLowerCase()}`,
      editTokenHash: sha256Hex(editToken),
      shareCode,
      title,
      data: {
        folders: [],
        items: [
          {
            id: `i-${gear}`,
            folderId: null,
            name: gear,
            unitWeightMg: 500_000,
            qty: 1,
            classification: "base",
            sortOrder: 0,
          },
        ],
      },
    })
    .returning();
  return { editToken, id: rows[0]!.id };
}

const vaultIdFor = async (db: DB, userId: number): Promise<number | null> => {
  const r = await db.execute(sql.raw(`select id from vaults where user_id = ${userId}`));
  const rows = (r as unknown as { rows: { id: number }[] }).rows;
  return rows[0]?.id ?? null;
};

const gearIn = async (db: DB, vaultId: number): Promise<string[]> => {
  const r = await db.execute(
    sql.raw(`select name from vault_items where vault_id = ${vaultId} order by name`),
  );
  return (r as unknown as { rows: { name: string }[] }).rows.map((x) => x.name);
};

describe("rebuilding a vault from claimed lists", () => {
  let db: DB;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("writes the gear into THIS account's vault, minting one if there isn't one yet", async () => {
    const user = await makeUser(db, "ryan@example.com");
    const list = await makeListWithGear(db, "Sierra", "Tent X");
    await claimLists(db as never, user, [list.editToken]);

    const written = await backfillVaultFromClaims(db as never, user);
    expect(written).toBe(1);

    const vault = await vaultIdFor(db, user);
    expect(vault).not.toBeNull();
    expect(await gearIn(db, vault!)).toEqual(["Tent X"]);
  });

  // The regression. Ids are forced apart so that passing a userId where a vaultId
  // belongs writes somewhere real and WRONG — if the two happened to coincide the
  // old bug would pass this test.
  it("never writes into another account's vault, even when their id matches ours", async () => {
    const other = await makeUser(db, "someone@example.com");
    // give the other account a vault whose id equals the id our user will have
    await db.execute(sql.raw(`insert into vaults (id, user_id) values (9001, ${other})`));

    const user = await makeUser(db, "ryan@example.com");
    await db.execute(sql.raw(`update users set id = 9001 where id = ${user}`));
    const list = await makeListWithGear(db, "Sierra", "Tent X");
    await db.execute(
      sql.raw(`insert into list_claims (user_id, list_id) values (9001, ${list.id})`),
    );

    await backfillVaultFromClaims(db as never, 9001);

    // the other account's vault is id 9001 — the exact number our userId is now
    expect(await gearIn(db, 9001)).toEqual([]);
    const mine = await vaultIdFor(db, 9001);
    expect(mine).not.toBe(9001);
    expect(await gearIn(db, mine!)).toEqual(["Tent X"]);
  });

  it("folds several claimed lists into one vault, deduping shared gear", async () => {
    const user = await makeUser(db, "ryan@example.com");
    const a = await makeListWithGear(db, "Sierra", "Tent X");
    const b = await makeListWithGear(db, "Cascades", "Tent X");
    const c = await makeListWithGear(db, "Desert", "Stove Y");
    await claimLists(db as never, user, [a.editToken, b.editToken, c.editToken]);

    await backfillVaultFromClaims(db as never, user);
    const vault = await vaultIdFor(db, user);
    expect(await gearIn(db, vault!)).toEqual(["Stove Y", "Tent X"]);
  });

  it("is idempotent — running it twice doesn't duplicate rows", async () => {
    const user = await makeUser(db, "ryan@example.com");
    const list = await makeListWithGear(db, "Sierra", "Tent X");
    await claimLists(db as never, user, [list.editToken]);

    await backfillVaultFromClaims(db as never, user);
    await backfillVaultFromClaims(db as never, user);

    const vault = await vaultIdFor(db, user);
    expect(await gearIn(db, vault!)).toEqual(["Tent X"]);
  });

  it("does nothing, and mints nothing, for an account with no claims", async () => {
    const user = await makeUser(db, "ryan@example.com");
    expect(await backfillVaultFromClaims(db as never, user)).toBe(0);
    // no claims means no gear, and no reason to bring a vault row into existence
    expect(await vaultIdFor(db, user)).toBeNull();
  });

  it("respects a pinned field — signing in elsewhere can't undo an edit", async () => {
    // The backfill runs captureVaultItems, so everything the pin protects against a
    // capture it has to protect against this too. Otherwise correcting a weight on
    // /gear would hold until the next device you signed in on, which is the one
    // moment the vault is supposed to prove itself.
    const user = await makeUser(db, "ryan@example.com");
    const list = await makeListWithGear(db, "Sierra", "Tent X");
    await claimLists(db as never, user, [list.editToken]);
    await backfillVaultFromClaims(db as never, user);

    const gear = (await vaultIdFor(db, user))!;
    const row = (await listVaultItems(db as never, gear))[0]!;
    await applyVaultItemOp(db as never, gear, {
      t: "edit",
      id: row.id,
      patch: { weightMg: 480_000 },
    });

    await backfillVaultFromClaims(db as never, user);
    expect((await listVaultItems(db as never, gear))[0]!.weightMg).toBe(480_000);
  });
});
