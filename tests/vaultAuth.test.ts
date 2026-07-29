// The vault's identity layer — the piece that replaced accounts.
//
// A vault is owned by possession of a token, exactly like a list's edit link. What
// has to hold, and is pinned here:
//   • the raw token is never stored, only sha256, so a database dump grants nothing;
//   • an unknown token is refused rather than silently given a fresh vault;
//   • one vault can never read or write another's rows, whatever id it names.
//
// The repo-layer scoping is the part worth the most attention: an id from another
// vault has to match NOTHING, not "match and then get filtered", because the second
// shape is the one that quietly stops being true when someone adds a query.
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { vaults } from "../server/db/schema";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { sha256Hex } from "../server/utils/tokens";
import {
  applyVaultFolderOp,
  captureVaultItems,
  listVaultFolders,
  listVaultItems,
  removeVaultItem,
} from "../server/utils/vaultRepo";
import { vaultNormKey } from "../shared/vault";

type DB = ReturnType<typeof drizzle>;

async function freshDb(): Promise<DB> {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of VAULT_DDL) await db.execute(sql.raw(stmt));
  return db;
}

// The mint/resolve pair, exercised at the DB layer. requireVault() itself takes an
// H3Event and is a thin wrapper over exactly this — booting a server to assert a
// WHERE clause would test the framework, not the rule.
async function mint(db: DB, token: string): Promise<number> {
  const rows = await db.insert(vaults).values({ tokenHash: sha256Hex(token) }).returning();
  return rows[0]!.id;
}
async function resolve(db: DB, token: string): Promise<number | null> {
  const rows = await db.select().from(vaults).where(sql`token_hash = ${sha256Hex(token)}`).limit(1);
  return rows[0]?.id ?? null;
}

const cap = (name: string, over: Record<string, unknown> = {}) =>
  ({
    normKey: vaultNormKey(null, name, null),
    name,
    weightMg: 100_000,
    ...over,
  }) as never;

describe("vault tokens", () => {
  let db: DB;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("stores only the hash — the raw token is not recoverable from the row", async () => {
    const token = "a-high-entropy-token";
    const id = await mint(db, token);

    const rows = await db.select().from(vaults);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.tokenHash).toBe(sha256Hex(token));
    // the value someone would need in order to use the vault appears nowhere
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it("resolves a minted token and refuses anything else", async () => {
    const id = await mint(db, "real-token");
    expect(await resolve(db, "real-token")).toBe(id);
    expect(await resolve(db, "not-the-token")).toBeNull();
    // near-misses are not near: the hash is all-or-nothing
    expect(await resolve(db, "real-toke")).toBeNull();
    expect(await resolve(db, "Real-Token")).toBeNull();
  });

  it("mints distinct vaults for distinct tokens", async () => {
    const a = await mint(db, "token-a");
    const b = await mint(db, "token-b");
    expect(a).not.toBe(b);
  });

  it("refuses a second vault on the same token", async () => {
    await mint(db, "same");
    await expect(mint(db, "same")).rejects.toThrow();
  });
});

describe("vault isolation — one vault can never reach another's gear", () => {
  let db: DB;
  let mine: number;
  let theirs: number;
  beforeEach(async () => {
    db = await freshDb();
    mine = await mint(db, "mine");
    theirs = await mint(db, "theirs");
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
