// Database access. Local dev uses PGlite (in-process Postgres, zero setup);
// production uses Neon when DATABASE_URL is set. Same Drizzle API either way.
// Schema is ensured idempotently on first use (dev); prod would run migrations.

import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { CATALOG_DDL } from "./catalog";

type Db = Awaited<ReturnType<typeof build>>;

let _dbPromise: Promise<Db> | undefined;

async function build() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import("drizzle-orm/neon-http");
    const { neon } = await import("@neondatabase/serverless");
    // Prod: schema is applied via migrations at deploy time, NOT on the request
    // path (running DDL per cold-start adds latency + a first-deploy race).
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

const DDL = [
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
    season text,
    primary_category text,
    claim_phrase_hash text,
    version integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_edit_token ON lists(edit_token_hash) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_share_code ON lists(share_code) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_slug ON lists(public_slug) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_lists_feed ON lists(base_weight_mg) WHERE is_public AND status='active' AND deleted_at IS NULL`,
  // catalog_items (Phase 2) — single-sourced in server/utils/catalog.ts so the
  // seed script + search endpoint can ensure it on Neon too. These are safe on
  // both engines; the pg_trgm GIN index is created Neon-only (see catalog.ts).
  ...CATALOG_DDL,
];

async function ensureSchema(db: Db) {
  for (const stmt of DDL) await db.execute(sql.raw(stmt));
}

export async function useDb(): Promise<Db> {
  if (!_dbPromise) _dbPromise = build();
  return _dbPromise;
}
