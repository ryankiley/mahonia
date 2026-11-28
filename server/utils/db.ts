// Database access. Local dev uses PGlite (in-process Postgres, zero setup);
// production uses Neon when DATABASE_URL is set. Same Drizzle API either way.
// There is no migration step: the schema is ensured idempotently on first use, by
// build() in dev and by useDb() on Neon.

import { sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { CATALOG_DDL, CATALOG_NEON_DDL } from "./catalog";
import { CANDIDATES_DDL } from "./candidates";
import { VAULT_DDL } from "./vaultSchema";
import { ACCOUNT_DDL } from "./accountSchema";
import { alteringLast, runDdl } from "./ddl";
import { memoized } from "./memoize";

/**
 * The connection handle every repo takes: Neon's HTTP driver in production,
 * PGlite in dev and tests. Typed as the base class both drivers extend, so the
 * whole query builder (a narrowed `.returning({ col })` included) is one set of
 * signatures rather than the intersection of two.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * A unique-index violation, as it reaches a caller. drizzle wraps every driver
 * error in a DrizzleQueryError and keeps the driver's own error on `cause`, so the
 * SQLSTATE is one level down: reading `.code` off the thrown value never matches
 * (createList's slug retry did exactly that, and never retried). Both drivers —
 * neon-http in prod, PGlite locally and in tests — go through the same wrapper.
 */
export function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505";
}

/**
 * How many rows of `table` match `where` (all of them when it is left out): one
 * `select count(*)`, as a number. A count is a bigint, which Neon's driver hands
 * back as text and PGlite as a number, so the conversion is here once rather than
 * at each cap that asks.
 */
export async function countRows(db: Db, table: PgTable, where?: SQL): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(table).where(where);
  return Number(row?.n ?? 0);
}

let _dbPromise: Promise<Db> | undefined;

async function build(): Promise<Db> {
  // Neon's connection string. Unset means local PGlite: dev, the scripts and the tests.
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import("drizzle-orm/neon-http");
    const { neon } = await import("@neondatabase/serverless");
    // The schema is not ensured here: this promise is kept for the life of the
    // instance, so a failed ensure inside it would fail every later request too.
    // useDb() runs it, where a failure is retried.
    return drizzle(neon(url), { schema });
  }
  // @electric-sql/pglite is kept OUT of the deployed server bundle — its wasm
  // weighed ~17 MB, 77% of the server output, and prod (DATABASE_URL set) never
  // reaches this branch. It is a devDependency for the same reason: only this
  // dev branch, the scripts and the tests ever load it. Two mechanisms, both
  // required:
  //  1. the computed specifier below stops rollup resolving the package as an
  //     external entry (an entry bypasses the trace ignore);
  //  2. nitro.externals.traceOptions.ignore (nuxt.config) drops the package's
  //     files where node-file-trace reaches them transitively via the
  //     drizzle-orm/pglite driver (whose small JS still ships).
  // Locally nothing changes: with no copy inside .output, Node resolves the bare
  // specifier by walking up to the workspace's node_modules, so `nuxt preview`,
  // scripts, and tests keep working. A prod deploy WITHOUT a DATABASE_URL now
  // fails loudly here instead of silently writing to an ephemeral per-instance
  // database — a strictly better failure mode.
  const pgliteSpec = ["@electric-sql", "pglite"].join("/");
  const { PGlite } = (await import(/* @vite-ignore */ pgliteSpec)) as typeof import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { mkdirSync } = await import("node:fs");
  const dir = process.env.PGLITE_DIR || ".data/pglite";
  // persisted local file so dev data survives restarts (PGlite's mkdir isn't recursive)
  mkdirSync(dir, { recursive: true });
  const db = drizzle(new PGlite(dir), { schema });
  try {
    await runDdl(db, SCHEMA_DDL); // local dev only — idempotent
  } catch (error) {
    throw (await writtenByAnotherPostgres(dir, () => PGlite.create())) ?? error;
  }
  return db;
}

/**
 * The reason a local database folder won't open, when the reason is its age.
 *
 * A PGlite release that moves to a new Postgres major (0.6.0 went 18 → 19) can't
 * read a folder the previous one wrote, and all it says is "PGlite failed to
 * initialize properly", wrapped in the first query that ran. The folder records
 * the major that wrote it in PG_VERSION, so on a failed open that file is compared
 * with a throwaway in-memory instance's own version. Only on the failure path: a
 * second instance costs about half a second, and a healthy open never pays it.
 *
 * Returns nothing when the folder has no PG_VERSION or the majors agree, so any
 * other failure reaches the caller as it was thrown. The folder is left alone:
 * it may hold the only copy of someone's local lists.
 */
export async function writtenByAnotherPostgres(
  dir: string,
  probe: () => Promise<{ query: (sql: string) => Promise<{ rows: unknown[] }>; close: () => Promise<void> }>,
): Promise<Error | undefined> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  let wrote: string;
  try {
    wrote = readFileSync(join(dir, "PG_VERSION"), "utf8").trim();
  } catch {
    return undefined;
  }
  const pg = await probe();
  const { rows } = await pg.query("show server_version");
  await pg.close();
  const runs = String((rows[0] as { server_version?: unknown } | undefined)?.server_version ?? "").split(".")[0];
  if (!runs || runs === wrote) return undefined;
  return new Error(
    `The local database in ${dir} was written by PostgreSQL ${wrote}, and the installed PGlite runs PostgreSQL ${runs}, which can't read it. ` +
      `Move or delete that folder and start again: the schema is rebuilt on first use, and \`npm run seed\` refills the catalog.`,
  );
}

// lists DDL. Safe on PGlite + Neon.
// CREATE TABLE IF NOT EXISTS won't add a column to a table that already exists, so a
// new column ships as an ALTER beside its CREATE and is folded in once it has
// deployed (see CLAUDE.md).
export const LISTS_DDL: string[] = [
  // author_user_id is the byline on the read views: who MADE the list (set once at
  // creation, never re-pointed by a claim); resolves to that account's optional
  // display name.
  `CREATE TABLE IF NOT EXISTS lists (
    id serial PRIMARY KEY,
    public_slug text NOT NULL,
    edit_token_hash text NOT NULL,
    share_code text NOT NULL,
    title text NOT NULL DEFAULT 'Untitled list',
    description text,
    display_unit text NOT NULL DEFAULT 'g',
    trail_url text,
    trail_label text,
    data jsonb NOT NULL,
    total_weight_mg bigint NOT NULL DEFAULT 0,
    item_count integer NOT NULL DEFAULT 0,
    last_snapshot_at timestamptz,
    version integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    trail_distance_m integer,
    trail_distance_unit text,
    trail_profile text,
    trail_ascent_m integer,
    trail_descent_m integer,
    route_geometry text,
    start_date text,
    end_date text,
    author_user_id integer
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_edit_token ON lists(edit_token_hash) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_share_code ON lists(share_code) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_slug ON lists(public_slug) WHERE deleted_at IS NULL`,
  // the nightly reap's scan (reapAbandonedLists): abandoned near-empty drafts. Serves
  // the `updated_at < cutoff` RANGE — the query takes no order, it just takes the
  // first `limit` rows the scan yields. Without this the sweep is a full table scan
  // that gets slower every day the table grows. The predicate is written to match the
  // query's exactly, so the planner can prove one implies the other. The
  // jsonb_array_length guard in the query stays out of it: it is a cheap recheck on
  // an already-narrow candidate set, not something to index.
  `CREATE INDEX IF NOT EXISTS idx_lists_reap ON lists(updated_at) WHERE status='active' AND deleted_at IS NULL AND item_count <= 1`,
  // the second stage (purgeDeletedLists) walks the OPPOSITE condition to every
  // partial index above: soft-deleted rows past the grace window. `WHERE deleted_at
  // IS NULL` cannot serve `WHERE deleted_at IS NOT NULL`, so this is its own index.
  `CREATE INDEX IF NOT EXISTS idx_lists_purge ON lists(deleted_at) WHERE deleted_at IS NOT NULL`,
];

// list_snapshots (vandalism-recovery). Idempotent + safe on both engines.
export const SNAPSHOTS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS list_snapshots (
    id serial PRIMARY KEY,
    list_id integer NOT NULL,
    kind text NOT NULL DEFAULT 'base',
    snapshot jsonb NOT NULL,
    item_count integer NOT NULL DEFAULT 0,
    version integer NOT NULL,
    reason text,
    actor text,
    editor_user_id integer,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_list_snapshots_list ON list_snapshots(list_id, created_at DESC)`,
];

// trail_favicons — one row per HOST, not per list (see server/db/schema.ts).
export const TRAIL_FAVICONS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS trail_favicons (
    host text PRIMARY KEY,
    data_url text,
    fetched_at timestamptz NOT NULL DEFAULT now()
  )`,
  // the monthly refresh sweep reads oldest-first; without this it seq-scans
  `CREATE INDEX IF NOT EXISTS idx_trail_favicons_stale ON trail_favicons(fetched_at)`,
];

/**
 * Every table the app has, as one list: lists and their recovery points, the catalog,
 * My Gear and the account layer. One list, so one ensure, and no path can reach a
 * table nothing made yet. The accepted price: a statement that fails anywhere in it
 * fails every request that reads the database, a share page as much as the sign-in
 * the statement belongs to.
 */
export const SCHEMA_DDL: string[] = alteringLast([
  LISTS_DDL,
  CATALOG_DDL,
  CANDIDATES_DDL,
  SNAPSHOTS_DDL,
  TRAIL_FAVICONS_DDL,
  VAULT_DDL,
  ACCOUNT_DDL,
]);

/** What useDb() runs on Neon: the extensions only Neon ships, then the whole schema. */
export const NEON_DDL: string[] = [...CATALOG_NEON_DDL, ...SCHEMA_DDL];

// Once per instance, however many requests arrive on it cold, and again on the next
// request if it failed (memoized).
const ensureSchema = memoized((db: Db) => runDdl(db, NEON_DDL));

/**
 * The database, with every table made. The one accessor: on Neon the tables are
 * created on first use rather than migrated, and this is where; dev's PGlite made
 * them in build().
 */
export async function useDb(): Promise<Db> {
  if (!_dbPromise) _dbPromise = build();
  const db = await _dbPromise;
  if (process.env.DATABASE_URL) await ensureSchema(db);
  return db;
}
