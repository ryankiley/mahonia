// DDL for the vault. A LEAF module: it imports nothing from db.ts, so db.ts can
// spread it into the local dev DDL while vaultRepo.ts imports its connection back
// from db.ts — the same shape as CATALOG_DDL, minus the import cycle that would
// follow from putting the statements in the repo module itself.
//
// Every statement is idempotent and safe on BOTH engines (PGlite locally, Neon in
// production, where there's no build-time migration step and the schema is ensured
// on first use). See server/db/schema.ts for what each table is for.

export const VAULT_DDL: string[] = [
  // A vault is owned by a LINK, not an account: token_hash is sha256 of the token
  // the holder keeps, and possession is the whole authorisation model — exactly as
  // lists.edit_token_hash works. No users table, no sessions, no email.
  `CREATE TABLE IF NOT EXISTS vaults (
    id serial PRIMARY KEY,
    token_hash text NOT NULL,
    -- the currency this vault's gear costs are recorded in (null = the default).
    -- Per VAULT, not per item: /vault shows a running total, and summing mixed
    -- currencies would be arithmetic on incomparable numbers.
    currency text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_token ON vaults (token_hash)`,

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
    price_cents integer,
    currency text,
    times_seen integer NOT NULL DEFAULT 1,
    last_used_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // the upsert target — one row per piece of gear per vault
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
