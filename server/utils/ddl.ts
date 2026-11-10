import { sql } from "drizzle-orm";
import { memoized } from "./memoize";
import type { Db } from "./db";

/**
 * Run a DDL list as ONE statement: a single DO block holding every statement in
 * order. On Neon's HTTP driver each execute is its own request, and the lists here
 * run to thirty-odd statements each, so statement-by-statement a cold instance paid
 * some ninety round trips before its first real query. It is also one transaction,
 * so a list lands whole or not at all. The statements stay a plain array because
 * each must still be valid on its own (a `DO $$ … $$` among them nests fine inside
 * the differently-tagged outer block).
 */
export async function runDdl(db: Db, ddl: readonly string[]): Promise<void> {
  if (ddl.length === 0) return;
  await db.execute(sql.raw(`DO $ddl$ BEGIN\n${ddl.map((stmt) => `${stmt};`).join("\n")}\nEND $ddl$`));
}

/** A memoized ensure for one DDL list — the shape every self-ensuring table takes. */
export const ensureOf = (ddl: readonly string[]) => memoized((db: Db) => runDdl(db, ddl));
