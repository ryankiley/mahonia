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
  captureVaultItems,
  listVaultItems,
  removeVaultItem,
  setVaultItemPrice,
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
});
