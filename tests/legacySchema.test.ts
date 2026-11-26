// The retired columns and table as an OLDER database meets them: production still has
// them when a new build's ensure first runs there. The DDL drops them in place and keeps
// every row.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { lists } from "../server/db/schema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { LISTS_DDL } from "../server/utils/db";
import { runDdl } from "../server/utils/ddl";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { createTestDb, type TestDb } from "./helpers/db";

const DDL = [...LISTS_DDL, ...CATALOG_DDL, ...VAULT_DDL];

// what an earlier build left behind on top of today's tables
const LEGACY = [
  `ALTER TABLE lists ADD COLUMN primary_category text, ADD COLUMN view_count integer NOT NULL DEFAULT 0,
     ADD COLUMN claim_phrase_hash text, ADD COLUMN is_public boolean NOT NULL DEFAULT false,
     ADD COLUMN published_at timestamptz, ADD COLUMN trip_type text, ADD COLUMN season text,
     ADD COLUMN flagged boolean NOT NULL DEFAULT false`,
  `ALTER TABLE catalog_items ADD COLUMN description text, ADD COLUMN image_url text,
     ADD COLUMN msrp_cents integer, ADD COLUMN currency text`,
  `ALTER TABLE catalog_edits ADD COLUMN confirmations integer NOT NULL DEFAULT 0`,
  `ALTER TABLE vault_items ADD COLUMN folder_id integer, ADD COLUMN description text,
     ADD COLUMN description_pinned boolean NOT NULL DEFAULT false`,
  `CREATE TABLE vault_folders (
     id serial PRIMARY KEY,
     vault_id integer NOT NULL,
     name text NOT NULL,
     sort_order integer NOT NULL DEFAULT 0,
     sort_by text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX idx_vault_folder_name ON vault_folders (vault_id, name)`,
];

async function columns(db: TestDb, table: string): Promise<string[]> {
  const res = await db.execute(
    sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`,
  );
  return (res.rows as { column_name: string }[]).map((r) => r.column_name);
}

async function hasTable(db: TestDb, table: string): Promise<boolean> {
  const res = await db.execute(sql`SELECT to_regclass(${table}) IS NOT NULL AS present`);
  return (res.rows[0] as { present: boolean }).present;
}

describe("the retired columns on a database that still has them", () => {
  async function olderDb(): Promise<TestDb> {
    const db = await createTestDb(DDL, LEGACY);
    await db.execute(sql`INSERT INTO lists (public_slug, edit_token_hash, share_code, data, is_public, view_count)
      VALUES ('slug', 'hash', 'CODE', '{"folders":[],"items":[]}', true, 3)`);
    await db.execute(sql`INSERT INTO vault_items (vault_id, norm_key, name, folder_id, description)
      VALUES (1, 'tent', 'Tent', 9, 'Sam carries this')`);
    await db.execute(sql`INSERT INTO vault_folders (vault_id, name) VALUES (1, 'Shelter')`);
    // the older shape really is there, so the drops below have something to drop
    expect(await hasTable(db, "vault_folders")).toBe(true);
    expect(await columns(db, "lists")).toContain("is_public");
    return db;
  }

  it("drops them on the next ensure, and the one after is a no-op", async () => {
    const db = await olderDb();
    await runDdl(db, DDL);
    await runDdl(db, DDL);

    const listCols = await columns(db, "lists");
    for (const c of ["primary_category", "view_count", "claim_phrase_hash"]) expect(listCols).not.toContain(c);
    for (const c of ["is_public", "published_at", "trip_type", "season", "flagged"]) expect(listCols).not.toContain(c);
    const catalogCols = await columns(db, "catalog_items");
    for (const c of ["description", "image_url", "msrp_cents", "currency"]) expect(catalogCols).not.toContain(c);
    expect(await columns(db, "catalog_edits")).not.toContain("confirmations");
    const vaultCols = await columns(db, "vault_items");
    for (const c of ["folder_id", "description", "description_pinned"]) expect(vaultCols).not.toContain(c);
    // the price's currency is a live column of the same name, on the gear, not the catalog
    expect(vaultCols).toContain("currency");
    expect(await hasTable(db, "vault_folders")).toBe(false);
  });

  it("keeps every row, and today's select reads them", async () => {
    const db = await olderDb();
    await runDdl(db, DDL);
    const [list] = await db.select().from(lists);
    expect(list!.shareCode).toBe("CODE");
    const gear = await db.execute(sql`SELECT name FROM vault_items`);
    expect(gear.rows).toEqual([{ name: "Tent" }]);
  });

  it("creates none of them on a fresh database", async () => {
    const db = await createTestDb(DDL);
    expect(await columns(db, "lists")).not.toContain("is_public");
    expect(await columns(db, "catalog_items")).not.toContain("msrp_cents");
    expect(await hasTable(db, "vault_folders")).toBe(false);
  });
});
