import { sql } from "drizzle-orm";
import type { Db } from "./db";

/**
 * A DDL list as ONE statement: a single DO block holding every statement in order.
 * On Neon's HTTP driver each execute is its own request, so statement by statement a
 * cold instance paid a round trip for each before its first real query. It is also
 * one transaction, so the list lands whole or not at all. The statements stay a plain
 * array because each must still be valid on its own.
 *
 * An index is created only where its name is free. `CREATE INDEX IF NOT EXISTS` takes
 * a ShareLock on its table before it looks for the name, and holds it to the end of
 * the transaction, so on a database that already has everything the bare statements
 * would block every write to every table for as long as the block runs; asked this
 * way, a run that has nothing to make locks no table at all.
 */
export function ddlBlock(ddl: readonly string[]): string {
  const body = ddl.map((stmt) => {
    const index = /^\s*CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/.exec(stmt)?.[1];
    return index ? `IF to_regclass('${index}') IS NULL THEN ${stmt}; END IF;` : `${stmt};`;
  });
  return `DO $ddl$ BEGIN\n${body.join("\n")}\nEND $ddl$`;
}

/** Run a DDL list as its one block (ddlBlock). */
export async function runDdl(db: Db, ddl: readonly string[]): Promise<void> {
  if (ddl.length === 0) return;
  await db.execute(sql.raw(ddlBlock(ddl)));
}
