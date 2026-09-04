import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../../server/db/schema";
import { randomEditToken, randomShareCode, sha256Hex } from "../../server/utils/tokens";

/**
 * A throwaway Postgres with the schema already on it.
 *
 * Twenty test files opened with the same two lines — `drizzle(new PGlite(), {
 * schema })`, then a loop running some concatenation of the DDL groups — and
 * eighteen of them called the wrapper `freshDb`. The only thing that ever varied
 * was which groups went in.
 *
 * Pass the groups in the order the schema needs them:
 *
 *   const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
 *
 * WHAT THIS COSTS, because it is the suite's dominant expense and the number is
 * not obvious: a PGlite instance is a WASM Postgres, and booting one measures
 * ~494 ms while running all 46 DDL statements measures ~15 ms. The schema is
 * free; the boot is everything. At ~96 calls across the suite that is ~49 s of
 * setup, and because vitest runs files in parallel those boots contend for CPU —
 * which is why the DB-backed files are the ones that time out first on a small
 * runner (see vitest.config.ts, which already raised the timeout once for this).
 *
 * So the optimization worth doing, if this ever needs one, is fewer BOOTS — one
 * instance per file with the schema reset between cases, not a faster DDL. It is
 * deliberately not done here: the ensure-helpers memoize "this schema is already
 * built" per process (server/utils/memoize.ts), so reusing an instance means
 * resetting every one of those memos in lockstep, and getting that subtly wrong
 * trades a slow suite for a lying one.
 */
export async function createTestDb(...ddlGroups: string[][]): Promise<TestDb> {
  const db = drizzle(new PGlite(), { schema });
  for (const group of ddlGroups) {
    for (const stmt of group) await db.execute(sql.raw(stmt));
  }
  return db;
}

/** The handle createTestDb returns — the shape the repos take as their `db`. */
export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/** An account row, by email, returning its id — the account-scoped suites
 *  (vault backfill, account delete) each carried this same three-liner. */
export async function makeUser(db: TestDb, email: string): Promise<number> {
  const rows = await db.insert(schema.users).values({ email }).returning();
  return rows[0]!.id;
}

/**
 * Insert a list row directly — createList() reaches for the shared connection,
 * and these suites want a throwaway database per case. Three files each carried
 * a byte-identical copy of the token/slug/hash preamble, diverging only in the
 * row's extras; `extra` is that divergence (last-write-wins over the defaults,
 * including `data`).
 */
export async function makeList(
  db: TestDb,
  title = "Sierra trip",
  extra: Partial<typeof schema.lists.$inferInsert> = {},
) {
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
      ...extra,
    })
    .returning();
  return { editToken, shareCode, id: rows[0]!.id };
}
