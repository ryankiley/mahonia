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
  //
  // share_code — the read-only link to this vault's gear (/g/{code}); null while the
  // owner hasn't turned one on, and set back to null to turn it off, so a link stops
  // working the moment it's off (shared/vaultShare.ts).
  `CREATE TABLE IF NOT EXISTS vaults (
    id serial PRIMARY KEY,
    user_id integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    share_code text
  )`,
  // one vault per account — also the conflict target that makes lazy minting safe
  // against two concurrent captures (see mintVault in vaultAuth.ts)
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_user ON vaults (user_id)`,
  // one link per code, among the vaults that have one turned on
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_share_code ON vaults (share_code) WHERE share_code IS NOT NULL`,

  // classification is a closed set; a check keeps a bad write out of the table
  // rather than relying on every caller.
  //
  // kcal is food energy per unit.
  //
  // price_cents and currency are what it cost. They share ONE pin: an amount and the
  // money it's in are one decision, and a capture able to revert half of it would
  // invent a price.
  //
  // The pins. A gear EDIT wins over capture: once you correct a field on /gear it
  // is pinned, and the merge coalesces around it instead of talking over it — the
  // gear's half of the rule Item.weightOverridden / nameOverridden already give a
  // list against the catalog. One flag per independent decision, which is why
  // brand/name/variant share name_pinned: they are one spelling of one identity, and
  // a capture rewrites all three together or none. No index — nothing queries a pin.
  //
  // icon is the icon you picked by hand for a piece (a name from shared/gearGlyph's
  // set); null means the gear type decides it. Nothing but the edit dialog writes it,
  // so it has no pin: there is no capture to protect it from.
  //
  // entry_unit is the unit a piece's weight reads in on /gear, picked per piece the
  // way a list row's entryUnit is; null follows the page's unit. Display only, never
  // a second weight.
  //
  // owned is how many of a piece you own; null is one. Set only on /gear (and by the
  // connector and an import, on your behalf), so it has no pin: no capture writes it.
  //
  // kind tells a piece from a kit, a row whose parts are in vault_kit_parts below.
  `CREATE TABLE IF NOT EXISTS vault_items (
    id serial PRIMARY KEY,
    vault_id integer NOT NULL,
    norm_key text NOT NULL,
    brand text,
    name text NOT NULL,
    variant text,
    common_name text,
    weight_mg bigint NOT NULL DEFAULT 0,
    classification text CONSTRAINT vault_classification_ck
      CHECK (classification IS NULL OR classification IN ('base','worn','consumable')),
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
    updated_at timestamptz NOT NULL DEFAULT now(),
    icon text,
    entry_unit text,
    owned integer,
    kind text NOT NULL DEFAULT 'piece' CONSTRAINT vault_kind_ck CHECK (kind IN ('piece','kit'))
  )`,
  // the upsert target — one row per piece of gear per vault
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_identity ON vault_items (vault_id, norm_key)`,
  // /vault's browse order and the autocomplete's candidate pool: live rows,
  // most-recently-used first
  `CREATE INDEX IF NOT EXISTS idx_vault_recent ON vault_items (vault_id, last_used_at DESC) WHERE removed_at IS NULL`,

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
