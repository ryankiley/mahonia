// Database access. Local dev uses PGlite (in-process Postgres, zero setup);
// production uses Neon when DATABASE_URL is set. Same Drizzle API either way.
// Schema is ensured idempotently on first use (dev); prod would run migrations.

import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { CATALOG_DDL, ensureCatalogSchema } from "./catalog";
import { CANDIDATES_DDL } from "./candidates";
import { memoizedEnsure } from "./memoize";

type Db = Awaited<ReturnType<typeof build>>;

let _dbPromise: Promise<Db> | undefined;

async function build() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import("drizzle-orm/neon-http");
    const { neon } = await import("@neondatabase/serverless");
    // Prod (Neon): the schema is ensured idempotently on first use via useDb()
    // below — memoized so it runs once per warm instance, mirroring the
    // snapshot + catalog tables. No separate migration step to forget.
    return drizzle(neon(url), { schema });
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { mkdirSync } = await import("node:fs");
  const dir = process.env.PGLITE_DIR || ".data/pglite";
  // persisted local file so dev data survives restarts (PGlite's mkdir isn't recursive)
  mkdirSync(dir, { recursive: true });
  const db = drizzle(new PGlite(dir), { schema });
  await ensureSchema(db); // local dev only — idempotent
  return db;
}

// lists DDL — single-sourced here (mirrors CATALOG_DDL) so tests can build a
// fresh DB with the exact production-faithful shape. Safe on PGlite + Neon.
// The ALTERs make column additions idempotent on a pre-existing dev database
// (CREATE TABLE IF NOT EXISTS won't add a column to a table that already exists).
export const LISTS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS lists (
    id serial PRIMARY KEY,
    public_slug text NOT NULL,
    edit_token_hash text NOT NULL,
    share_code text NOT NULL,
    title text NOT NULL DEFAULT 'Untitled list',
    description text,
    display_unit text NOT NULL DEFAULT 'g',
    data jsonb NOT NULL,
    base_weight_mg bigint NOT NULL DEFAULT 0,
    worn_weight_mg bigint NOT NULL DEFAULT 0,
    consumable_weight_mg bigint NOT NULL DEFAULT 0,
    total_weight_mg bigint NOT NULL DEFAULT 0,
    item_count integer NOT NULL DEFAULT 0,
    is_public boolean NOT NULL DEFAULT false,
    published_at timestamptz,
    trip_type text,
    season text,
    primary_category text,
    view_count integer NOT NULL DEFAULT 0,
    flagged boolean NOT NULL DEFAULT false,
    claim_phrase_hash text,
    last_snapshot_at timestamptz,
    version integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  )`,
  `ALTER TABLE lists ADD COLUMN IF NOT EXISTS trip_type text`,
  `ALTER TABLE lists ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE lists ADD COLUMN IF NOT EXISTS flagged boolean NOT NULL DEFAULT false`,
  `ALTER TABLE lists ADD COLUMN IF NOT EXISTS last_snapshot_at timestamptz`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_edit_token ON lists(edit_token_hash) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_share_code ON lists(share_code) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_slug ON lists(public_slug) WHERE deleted_at IS NULL`,
  // feed sort: lightest-packs leaderboard (base weight asc)
  `CREATE INDEX IF NOT EXISTS idx_lists_feed ON lists(base_weight_mg) WHERE is_public AND status='active' AND deleted_at IS NULL`,
  // feed sort: recent (published_at desc)
  `CREATE INDEX IF NOT EXISTS idx_lists_feed_recent ON lists(published_at DESC) WHERE is_public AND status='active' AND deleted_at IS NULL`,
  // browse-by-trip-type (the default feed): trip then recency
  `CREATE INDEX IF NOT EXISTS idx_lists_feed_trip ON lists(trip_type, published_at DESC) WHERE is_public AND status='active' AND deleted_at IS NULL`,
];

// list_snapshots (vandalism-recovery) — single-sourced here. Idempotent + safe on
// both engines; ensured on the request path too (ensureSnapshotSchema) so it
// exists on Neon without a migration, mirroring CATALOG_DDL.
export const SNAPSHOTS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS list_snapshots (
    id serial PRIMARY KEY,
    list_id integer NOT NULL,
    kind text NOT NULL DEFAULT 'base',
    snapshot jsonb NOT NULL,
    item_count integer NOT NULL DEFAULT 0,
    version integer NOT NULL,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  // idempotent column adds for pre-existing tables (Neon has no build-time DDL)
  `ALTER TABLE list_snapshots ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'base'`,
  `ALTER TABLE list_snapshots ADD COLUMN IF NOT EXISTS item_count integer NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_list_snapshots_list ON list_snapshots(list_id, created_at DESC)`,
];

/** Idempotently create the `lists` table + indexes (memoized) — for Neon, where
 *  there's no build-time DDL. Mirrors ensureSnapshotSchema; gated to the prod path
 *  in useDb (dev's PGlite already runs the full DDL in build()). */
const ensureListsSchema = memoizedEnsure(async (db: Db) => {
  for (const stmt of LISTS_DDL) await db.execute(sql.raw(stmt));
});

/** Idempotently create list_snapshots (memoized) — for Neon (no build-time DDL). */
export const ensureSnapshotSchema = memoizedEnsure(async (db: Db) => {
  for (const stmt of SNAPSHOTS_DDL) await db.execute(sql.raw(stmt));
});
/** Reset the ensure-memo — for tests that spin up a fresh database. */
export function _resetSnapshotEnsured(): void {
  ensureSnapshotSchema.reset();
}

const DDL = [
  ...LISTS_DDL,
  // catalog_items (Phase 2) — single-sourced in server/utils/catalog.ts so the
  // seed script + search endpoint can ensure it on Neon too. These are safe on
  // both engines; the pg_trgm GIN index is created Neon-only (see catalog.ts).
  ...CATALOG_DDL,
  ...CANDIDATES_DDL,
  ...SNAPSHOTS_DDL,
];

async function ensureSchema(db: Db) {
  for (const stmt of DDL) await db.execute(sql.raw(stmt));
}

export async function useDb(): Promise<Db> {
  if (!_dbPromise) _dbPromise = build();
  const db = await _dbPromise;
  // Neon has no build-time DDL (dev's PGlite ensured the schema in build()), so
  // ensure the core `lists` table exists on first use. Memoized → one batch per
  // warm instance. Snapshots + catalog self-ensure on their own paths.
  if (process.env.DATABASE_URL) await ensureListsSchema(db);
  return db;
}

/**
 * The shared DB with the catalog schema ensured. Every catalog endpoint needs
 * both — and forgetting the ensure is a Neon-only latent bug (works on PGlite,
 * where build() ran the full DDL, but throws in prod). Folding them into one call
 * makes that impossible to forget. Both are memoized, so this adds no round-trips.
 */
export async function useCatalogDb(): Promise<Db> {
  const db = await useDb();
  await ensureCatalogSchema(db);
  return db;
}
