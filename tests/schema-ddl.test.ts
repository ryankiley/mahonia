// The schema is written twice. The raw CREATE/ALTER strings (LISTS_DDL and the rest) are
// what makes the tables, on every cold instance, with no migration step; server/db/schema.ts
// is Drizzle's typed view of them, which every query is written against. A column added to
// one and not the other typechecks and fails at runtime, so here the DDL is run on PGlite
// and each side is read back against the other: every table and column, its type, whether
// it takes NULL, and whether the database fills a default Drizzle leaves to it.
//
// Both directions. A column the database has and schema.ts doesn't declare is drift too: no
// query can read it, so it is a column to drop (with its DDL, see no-migration-step) or to
// declare.

import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { CANDIDATES_DDL } from "../server/utils/candidates";
import { CATALOG_DDL } from "../server/utils/catalog";
import { LISTS_DDL, SNAPSHOTS_DDL, TRAIL_FAVICONS_DDL } from "../server/utils/db";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { createTestDb } from "./helpers/db";

interface Column {
  type: string;
  nullable: boolean;
  dbDefault: boolean;
}

// what information_schema calls the types Drizzle names by their DDL shorthand
const AS_STORED: Record<string, string> = {
  serial: "integer",
  bigserial: "bigint",
  smallserial: "smallint",
  timestamp: "timestamp without time zone",
  "timestamp with time zone": "timestamp with time zone",
};

/** The tables schema.ts declares, as the database would describe them. */
function declared(): Map<string, Map<string, Column>> {
  const tables = new Map<string, Map<string, Column>>();
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable)) continue;
    const config = getTableConfig(table);
    const keyed = new Set(config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)));
    const columns = new Map<string, Column>();
    for (const c of config.columns) {
      const type = c.getSQLType();
      columns.set(c.name, {
        type: AS_STORED[type] ?? type,
        nullable: !(c.notNull || c.primary || keyed.has(c.name)),
        // a serial's default is the database's sequence; `.default()` is a promise the
        // database keeps; `$defaultFn` is filled in by Drizzle and promises nothing
        dbDefault: type.endsWith("serial") || (c.hasDefault && c.defaultFn === undefined && c.onUpdateFn === undefined),
      });
    }
    tables.set(config.name, columns);
  }
  return tables;
}

describe("server/db/schema.ts and the DDL", () => {
  it("describe the same tables and columns", async () => {
    const db = await createTestDb(LISTS_DDL, CATALOG_DDL, CANDIDATES_DDL, SNAPSHOTS_DDL, TRAIL_FAVICONS_DDL, VAULT_DDL, ACCOUNT_DDL);
    const { rows } = await db.execute<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public'`,
    );
    const built = new Map<string, Map<string, Column>>();
    for (const r of rows) {
      const table = built.get(r.table_name) ?? built.set(r.table_name, new Map()).get(r.table_name)!;
      table.set(r.column_name, { type: r.data_type, nullable: r.is_nullable === "YES", dbDefault: r.column_default != null });
    }

    const drift: string[] = [];
    const want = declared();
    for (const [name, columns] of want) {
      const table = built.get(name);
      if (!table) {
        drift.push(`${name}: declared in schema.ts, made by no DDL`);
        continue;
      }
      for (const [column, d] of columns) {
        const b = table.get(column);
        if (!b) {
          drift.push(`${name}.${column}: declared in schema.ts, not in the DDL`);
          continue;
        }
        if (b.type !== d.type) drift.push(`${name}.${column}: ${d.type} in schema.ts, ${b.type} in the DDL`);
        if (b.nullable !== d.nullable)
          drift.push(`${name}.${column}: ${d.nullable ? "nullable" : "NOT NULL"} in schema.ts, ${b.nullable ? "nullable" : "NOT NULL"} in the DDL`);
        // the direction that breaks: Drizzle leaves the column out of an INSERT, and the
        // database has nothing to put there
        if (d.dbDefault && !b.dbDefault) drift.push(`${name}.${column}: schema.ts expects a database default the DDL doesn't set`);
      }
      for (const column of table.keys())
        if (!columns.has(column)) drift.push(`${name}.${column}: in the DDL, not declared in schema.ts`);
    }
    for (const name of built.keys()) if (!want.has(name)) drift.push(`${name}: made by the DDL, not declared in schema.ts`);

    expect(drift).toEqual([]);
  });
});
