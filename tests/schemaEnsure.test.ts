// The schema has no migration step: on Neon, useDb() makes every table before the first
// query of a cold instance, in one statement. This drives useDb() down its Neon branch
// with the driver swapped for this file's PGlite, so what reaches the database is what
// production would send, and nothing leaves the process.

import { is, sql, type SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import { claimedEditHash } from "../server/utils/claimRepo";
import { SCHEMA_DDL, type Db } from "../server/utils/db";
import { runDdl } from "../server/utils/ddl";
import { hydrateCatalogNames, listSnapshotsByEditHash, purgeDeletedLists } from "../server/utils/listRepo";
import { sha256Hex } from "../server/utils/tokens";
import type { ListSnapshot } from "../shared/types";
import { createTestDb, makeList, type TestDb } from "./helpers/db";

const neon = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@neondatabase/serverless", () => ({ neon: () => ({}) }));
vi.mock("drizzle-orm/neon-http", () => ({ drizzle: () => neon.db }));

/** What went over the wire as schema blocks, and how many of the next ones fail. */
interface Wire {
  blocks: string[];
  failures: number;
}

/** `db` as the Neon driver would hand it to build(): the same database, with each
 *  schema block recorded on its way in and failed on request. */
function asNeon(db: TestDb, wire: Wire): TestDb {
  const dialect = new PgDialect();
  const fake: TestDb = Object.create(db);
  fake.execute = ((query: SQL) => {
    const text = dialect.sqlToQuery(query).sql;
    if (!text.startsWith("DO $ddl$")) return db.execute(query);
    wire.blocks.push(text);
    if (wire.failures-- > 0) return Promise.reject(new Error("fetch failed"));
    // PGlite ships neither extension, so the block runs here without those two lines
    const runnable = text.split("\n").filter((line) => !line.startsWith("CREATE EXTENSION"));
    return db.execute(sql.raw(runnable.join("\n")));
  }) as TestDb["execute"];
  return fake;
}

const declared = Object.values(schema)
  .flatMap((t) => (is(t, PgTable) ? [getTableConfig(t).name] : []))
  .sort();

const namesOf = async (db: TestDb, catalog: "pg_tables" | "pg_indexes", column: string): Promise<string[]> => {
  const { rows } = await db.execute<{ name: string }>(
    sql`select ${sql.raw(column)} as name from ${sql.raw(catalog)} where schemaname = 'public' order by 1`,
  );
  return rows.map((r) => r.name);
};
const tablesOf = (db: TestDb) => namesOf(db, "pg_tables", "tablename");
const indexesOf = (db: TestDb) => namesOf(db, "pg_indexes", "indexname");

describe("useDb() on Neon", () => {
  let db: TestDb;
  let wire: Wire;
  /** useDb as a cold instance has it: the module freshly loaded, nothing remembered. */
  const coldUseDb = async (): Promise<() => Promise<Db>> => {
    vi.resetModules();
    return (await import("../server/utils/db")).useDb;
  };

  beforeEach(async () => {
    db = await createTestDb(); // no groups: a database nothing has ever touched
    wire = { blocks: [], failures: 0 };
    neon.db = asNeon(db, wire);
    vi.stubEnv("DATABASE_URL", "postgres://nobody@neon.invalid/none");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("makes every table schema.ts declares, in one statement, with Neon's extensions", async () => {
    const useDb = await coldUseDb();
    await useDb();

    expect(wire.blocks).toHaveLength(1);
    expect(await tablesOf(db)).toEqual(declared);
    expect(wire.blocks[0]).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    expect(wire.blocks[0]).toContain("CREATE EXTENSION IF NOT EXISTS unaccent;");
  });

  // Each of these reads was once the first to need a table only its own accessor made:
  // a list's recovery points, the catalog behind a share page, a claim at the edit
  // gate, the claims a purge drops. One accessor now, so none can arrive too early.
  it("answers the first read of every kind on a database nothing has touched", async () => {
    const useDb = await coldUseDb();
    const d = await useDb();
    const list = await makeList(db, "Cold start");
    const snap: ListSnapshot = {
      shareCode: list.shareCode, slug: "cold-start", title: "Cold start", displayUnit: "g", version: 1,
      folders: [],
      items: [{ id: "0", folderId: null, name: "Copied Thing", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0, catalogItemId: 1 }],
    };

    expect(await listSnapshotsByEditHash(sha256Hex(list.editToken), d)).toEqual([]);
    expect((await hydrateCatalogNames(d, snap)).items[0]!.name).toBe("Copied Thing");
    expect(await claimedEditHash(d, 1, list.shareCode)).toBeNull();
    expect(await purgeDeletedLists(d)).toEqual({ purged: 0 });
  });

  it("runs once for two requests that arrive together on a cold instance", async () => {
    const useDb = await coldUseDb();
    const [a, b] = await Promise.all([useDb(), useDb()]);
    await useDb();

    expect(wire.blocks).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("runs again on the next request after a run that failed", async () => {
    wire.failures = 1;
    const useDb = await coldUseDb();

    await expect(useDb()).rejects.toThrow("fetch failed");
    expect(await tablesOf(db)).toEqual([]);

    await useDb();
    expect(await tablesOf(db)).toEqual(declared);
    expect(wire.blocks).toHaveLength(2);
  });
});

describe("runDdl", () => {
  // Every cold instance runs the whole schema against a database that already has it,
  // beside live traffic. A lock taken there is held until the block ends, on every table.
  it("locks no table when everything is already there", async () => {
    const db = await createTestDb(SCHEMA_DDL);

    const held = await db.transaction(async (tx) => {
      await runDdl(tx, SCHEMA_DDL);
      const { rows } = await tx.execute<{ relname: string; mode: string }>(
        sql`select c.relname, l.mode from pg_locks l
            join pg_class c on c.oid = l.relation
            join pg_namespace n on n.oid = c.relnamespace
            where l.pid = pg_backend_pid() and n.nspname = 'public'`,
      );
      return rows;
    });

    expect(held).toEqual([]);
  });

  it("makes an index that is missing from a table that is there", async () => {
    const db = await createTestDb(SCHEMA_DDL);
    const all = await indexesOf(db);
    await db.execute(sql`drop index idx_lists_reap`);
    expect(await indexesOf(db)).not.toContain("idx_lists_reap");

    await runDdl(db, SCHEMA_DDL);
    expect(await indexesOf(db)).toEqual(all);
  });
});
