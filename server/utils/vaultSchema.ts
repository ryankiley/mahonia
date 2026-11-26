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
  // Soft-delete, for the nightly sweep of the vaults NO account owns (user_id IS
  // NULL, from before My Gear moved into an account): an account's vault is never
  // reaped or purged (vaultRepo). Cleared whenever a vault is used, so a mark on an
  // account's vault doesn't outlive its next request (see server/db/schema.ts).
  `ALTER TABLE vaults ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
  // the reap's scan (reapAbandonedVaults): vaults not yet soft-deleted, oldest-seen
  // first. It serves the last_seen_at range; the sweep's `user_id IS NULL` is a
  // recheck on the rows it yields, not part of the index.
  `CREATE INDEX IF NOT EXISTS idx_vaults_stale ON vaults (last_seen_at) WHERE deleted_at IS NULL`,
  // the purge's scan (purgeDeletedVaults) walks the OPPOSITE condition — vaults
  // already soft-deleted, past the grace window — which the index above cannot
  // serve, being scoped to exactly the rows the purge ignores. The same recheck on
  // `user_id IS NULL` applies.
  `CREATE INDEX IF NOT EXISTS idx_vaults_purge ON vaults (deleted_at) WHERE deleted_at IS NOT NULL`,
  // vault_folders, the folders My Gear had before it grouped by kind, dropped where it
  // still exists. It goes a deploy after the one that stopped deleting from it: a warm
  // instance of the deploy before that one would have failed partway through closing an
  // account had the table already been gone.
  `DROP TABLE IF EXISTS vault_folders`,

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
    kcal integer,
    catalog_item_id integer,
    product_url text,
    price_cents integer,
    currency text,
    name_pinned boolean NOT NULL DEFAULT false,
    weight_pinned boolean NOT NULL DEFAULT false,
    common_name_pinned boolean NOT NULL DEFAULT false,
    classification_pinned boolean NOT NULL DEFAULT false,
    kcal_pinned boolean NOT NULL DEFAULT false,
    product_url_pinned boolean NOT NULL DEFAULT false,
    price_pinned boolean NOT NULL DEFAULT false,
    times_seen integer NOT NULL DEFAULT 1,
    last_used_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // kcal — food energy per unit. ALTER so existing vaults gain it (the CREATE
  // above is a no-op once the table exists).
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS kcal integer`,
  // Retired, dropped where they still exist: the row's folder (folder_id, from
  // the dropped vault_folders), and the note My Gear kept until 2026-11-08 with its pin. The
  // note was mostly list notes that capture had copied in (a trip's "Sam carries this"
  // showing on the gear); a note belongs to a list row, and My Gear keeps none.
  `ALTER TABLE vault_items DROP COLUMN IF EXISTS folder_id, DROP COLUMN IF EXISTS description, DROP COLUMN IF EXISTS description_pinned`,
  // The pins. A gear EDIT wins over capture: once you correct a field on /gear it
  // is pinned, and the merge coalesces around it instead of talking over it — the
  // gear's half of the rule Item.weightOverridden / nameOverridden already give a
  // list against the catalog. One flag per independent decision, which is why
  // brand/name/variant share name_pinned: they are one spelling of one identity, and
  // a capture rewrites all three together or none. ALTERs so existing vaults gain
  // them, the same way kcal arrived. No index — nothing queries a pin.
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS name_pinned boolean NOT NULL DEFAULT false`,
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS weight_pinned boolean NOT NULL DEFAULT false`,
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS common_name_pinned boolean NOT NULL DEFAULT false`,
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS classification_pinned boolean NOT NULL DEFAULT false`,
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS kcal_pinned boolean NOT NULL DEFAULT false`,
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS product_url_pinned boolean NOT NULL DEFAULT false`,
  // What it cost, which capture used to drop. ALTERs so existing vaults gain them,
  // the same way kcal and the pins arrived — there is no migration step (see the
  // module comment), so the CREATE above only ever runs for a brand-new database.
  // price_cents and currency share ONE pin: an amount and the money it's in are one
  // decision, and a capture able to revert half of it would invent a price.
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS price_cents integer`,
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS currency text`,
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS price_pinned boolean NOT NULL DEFAULT false`,
  // The icon you picked by hand for a piece (a name from shared/gearGlyph's set); null
  // means the gear type decides it. Nothing but the edit dialog writes it, so it has
  // no pin: there is no capture to protect it from.
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS icon text`,
  // The unit a piece's weight reads in on /gear, picked per piece the way a list row's
  // entryUnit is; null follows the page's unit. Display only, never a second weight.
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS entry_unit text`,
  // How many of a piece you own; null is one. Set only on /gear (and by the connector
  // and an import, on your behalf), so it has no pin: no capture writes it.
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS owned integer`,
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

  // Kits. `kind` arrives by ALTER like every column after the first, and every row
  // that exists is a piece — the only kind there was. The CHECK is added the
  // tolerant way the classification one is.
  `ALTER TABLE vault_items ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'piece'`,
  `DO $$ BEGIN
     ALTER TABLE vault_items ADD CONSTRAINT vault_kind_ck CHECK (kind IN ('piece','kit'));
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // A kit's parts — see server/db/schema.ts. The primary key is the pair, so a
  // piece is in a kit once, with one qty; part_id has its own index because the
  // reads run the other way too ("which kits is this piece in", and setKitParts'
  // "is this row already somebody's part").
  `CREATE TABLE IF NOT EXISTS vault_kit_parts (
    kit_id integer NOT NULL,
    part_id integer NOT NULL,
    qty integer NOT NULL DEFAULT 1,
    sort_order integer NOT NULL DEFAULT 0,
    PRIMARY KEY (kit_id, part_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vault_kit_part ON vault_kit_parts (part_id)`,
];
