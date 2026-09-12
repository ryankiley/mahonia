import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../../server/db/schema";
import { randomEditToken, randomShareCode, sha256Hex } from "../../server/utils/tokens";

// the one instance this worker process boots — see createTestDb
let pglite: Promise<PGlite> | undefined;

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
 * WHAT THIS COSTS, because it was the suite's dominant expense: a PGlite instance
 * is a WASM Postgres, and booting one measures ~460 ms (~740 ms for the first in a
 * process, which also compiles the module), while running all 46 DDL statements
 * measures ~15 ms and wiping the schema measures ~3 ms. So the process boots ONE
 * instance, on the first call, and every call after that drops `public` and
 * rebuilds it from the groups it was handed — a database as empty as a new one, at
 * the price of the DDL alone. Vitest gives each test file its own worker process
 * (the default `isolate`), so "one per process" is one per file; the five heaviest
 * DB files went from 88 s to 7 s on the change, and the 20 s timeouts in
 * vitest.config.ts stopped being the first thing to fail under load.
 *
 * What makes the reuse safe, since the earlier version of this comment said it
 * wasn't: the schema-ensure helpers memoize "already built" per process
 * (server/utils/memoize.ts), and a memo that ran against one instance is exactly as
 * stale against the next fresh instance as it is against a wiped one — either way
 * the table it remembers is gone, and either way it is this function's DDL, run
 * directly, that puts the schema back. A case that wants the ensure itself to run
 * resets its memo (see snapshots.test.ts, hydrateCatalogNames.test.ts), which works
 * the same on a wiped database. Tests within a file run one at a time (nothing here
 * is `.concurrent`), so no case sees another's wipe; a case that builds a second
 * database mid-way (auth.test.ts) gets the same instance rebuilt, and the handle it
 * held before is the same database with the new schema — fine as long as it uses
 * only the new handle from there, which is what those cases do.
 */
export async function createTestDb(...ddlGroups: string[][]): Promise<TestDb> {
  pglite ??= PGlite.create();
  const pg = await pglite;
  await pg.exec("drop schema public cascade; create schema public;");
  const db = drizzle(pg, { schema });
  for (const group of ddlGroups) {
    for (const stmt of group) await db.execute(sql.raw(stmt));
  }
  return db;
}

/** The handle createTestDb returns — the shape the repos take as their `db`.
 *  EXPORTED because the generic is the whole point: a suite that writes its own
 *  `ReturnType<typeof drizzle>` silently drops `<typeof schema>` and lands on
 *  PgliteDatabase<Record<string, unknown>>, which no repo signature accepts — the
 *  files that did that had each papered over it with a cast at the call site. */
export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Call a hash-keyed repo function with the RAW edit token. The repos take
 * sha256(token) — an endpoint resolves either a bearer token or a session +
 * claimed code to that hash (server/utils/editAuth.ts) — but a suite genuinely
 * holds the token, so it hashes here rather than the repos carrying ByEditToken
 * wrappers no server code calls.
 */
export function byToken<A extends unknown[], R>(fn: (editHash: string, ...rest: A) => R) {
  return (editToken: string, ...rest: A): R => fn(sha256Hex(editToken), ...rest);
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
