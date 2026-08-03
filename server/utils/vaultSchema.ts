// DDL for the vault. A LEAF module: it imports nothing from db.ts, so db.ts can
// spread it into the local dev DDL while vaultRepo.ts imports its connection back
// from db.ts — the same shape as CATALOG_DDL, minus the import cycle that would
// follow from putting the statements in the repo module itself.
//
// Every statement is idempotent and safe on BOTH engines (PGlite locally, Neon in
// production, where there's no build-time migration step and the schema is ensured
// on first use). See server/db/schema.ts for what each table is for.

export const VAULT_DDL: string[] = [
  // A vault is owned by an ACCOUNT: user_id points at users.id, one vault per
  // user (idx_vaults_user below). Signing in on another device is what carries
  // it there — no transfer token, no link.
  `CREATE TABLE IF NOT EXISTS vaults (
    id serial PRIMARY KEY,
    user_id integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Ownership moved from a link to an account. Both statements are idempotent and
  // run on an existing table: the ADD gives pre-account rows a null owner, and the
  // DROP retires the token. A vault that was link-owned therefore becomes
  // unreachable rather than being reassigned — there is no honest way to guess
  // whose it was, and inventing an owner would hand someone else's gear to whoever
  // signed in first.
  `ALTER TABLE vaults ADD COLUMN IF NOT EXISTS user_id integer`,
  `ALTER TABLE vaults DROP COLUMN IF EXISTS token_hash`,
  // one vault per account — also the conflict target that makes lazy minting safe
  // against two concurrent captures (see mintVault in vaultAuth.ts)
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_user ON vaults (user_id)`,
  // soft-delete for the nightly reaper; cleared on use, so a late return revives
  // the vault instead of finding it gone (see server/db/schema.ts)
  `ALTER TABLE vaults ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
  // the reaper's scan: live vaults, oldest-seen first
  `CREATE INDEX IF NOT EXISTS idx_vaults_stale ON vaults (last_seen_at) WHERE deleted_at IS NULL`,

  // A vault's folders — see server/db/schema.ts for why they're a table and not a
  // label on the item. Name is unique per vault so capture can find-or-create by a
  // list folder's name without accumulating duplicates.
  `CREATE TABLE IF NOT EXISTS vault_folders (
    id serial PRIMARY KEY,
    vault_id integer NOT NULL,
    name text NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    sort_by text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_folder_name ON vault_folders (vault_id, name)`,

  `CREATE TABLE IF NOT EXISTS vault_items (
    id serial PRIMARY KEY,
    vault_id integer NOT NULL,
    norm_key text NOT NULL,
    brand text,
    name text NOT NULL,
    variant text,
    common_name text,
    weight_mg bigint NOT NULL DEFAULT 0,
    classification text,
    catalog_item_id integer,
    product_url text,
    folder_id integer,
    times_seen integer NOT NULL DEFAULT 1,
    last_used_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // the upsert target — one row per piece of gear per vault
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS folder_id integer`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_identity ON vault_items (vault_id, norm_key)`,
  // /vault's browse order and the autocomplete's candidate pool: live rows,
  // most-recently-used first
  `CREATE INDEX IF NOT EXISTS idx_vault_recent ON vault_items (vault_id, last_used_at DESC) WHERE removed_at IS NULL`,
  // classification is a closed set; a check keeps a bad write out of the table
  // rather than relying on every caller. Added separately (and tolerantly) because
  // ADD CONSTRAINT has no IF NOT EXISTS on older engines.
  `DO $$ BEGIN
     ALTER TABLE vault_items ADD CONSTRAINT vault_classification_ck
       CHECK (classification IS NULL OR classification IN ('base','worn','consumable'));
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
];
