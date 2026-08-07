// DDL for the OPTIONAL account layer. A LEAF module, like vaultSchema.ts: it
// imports nothing from db.ts, so db.ts can spread it into the local dev DDL while
// authSession.ts imports its connection back from db.ts.
//
// Every statement is idempotent and safe on BOTH engines (PGlite locally, Neon in
// production, where there's no build-time migration step and the schema is ensured
// on first use). See server/db/schema.ts for what each table is for.
//
// Nothing here is required to use Mahonia. A list is opened by its edit link and a
// vault by its vault link, both unchanged — an account only ever REMEMBERS
// capabilities you already hold, so that you don't have to keep the links yourself.

export const ACCOUNT_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
  )`,
  // REQUIRED, including on the passkey signup path. The passkey is what identifies
  // you; the address is the only way back in when every authenticator is lost, and
  // a vault is exactly the thing that can't be rebuilt from memory. Making it
  // optional put every account one lost phone away from being unrecoverable, and
  // made `email` nullable across code that reasonably assumed otherwise.
  //
  // email is stored already-lowercased, so a plain unique index gives the
  // case-insensitive identity users expect without needing the citext extension
  // (which PGlite doesn't ship).
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email)`,
  // optional, opt-in, and the only publicly visible part of an account
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text`,
  // HAS ANYONE EVER PROVED THEY HOLD THIS INBOX?
  //
  // false is the passkey-signup state. That route takes an address from an
  // unauthenticated body and attaches a credential to it without mailing it
  // first, so until a link sent there comes back, "this passkey belongs to this
  // address" is a claim and not a fact. true is every account the magic-link path
  // made, where the address IS the way in.
  //
  // What the flag is FOR is server/api/auth/verify.post.ts: redeeming a link for
  // a still-unverified account evicts every passkey and session that predates it.
  // Without that, anyone could sign up with a stranger's address, and the passkey
  // they left behind would keep opening the account that stranger later signs
  // into — see claimUnverifiedAccount in authSession.ts.
  //
  // ADDED true, DEFAULTED false, and the two halves do different jobs. Rows that
  // predate this column were written before the distinction existed and can't be
  // sorted into verified and not, so they're grandfathered rather than having
  // their owners' passkeys evicted on next sign-in. Everything created from here
  // on starts false and earns true. (To harden an existing deployment instead,
  // run `UPDATE users SET email_verified = false WHERE id IN (SELECT user_id FROM
  // credentials)` once, by hand, knowing it costs those accounts their passkeys.)
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true`,
  `ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false`,

  `CREATE TABLE IF NOT EXISTS auth_tokens (
    id serial PRIMARY KEY,
    token_hash text NOT NULL,
    user_id integer NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens (token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_tokens_expiry ON auth_tokens (expires_at)`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id serial PRIMARY KEY,
    token_hash text NOT NULL,
    user_id integer NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_hash ON sessions (token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at)`,

  // credentials — passkeys. Holds no secret: the private half never leaves the
  // authenticator, and a public key is useless to whoever steals it.
  `CREATE TABLE IF NOT EXISTS credentials (
    id serial PRIMARY KEY,
    user_id integer NOT NULL,
    credential_id text NOT NULL,
    public_key text NOT NULL,
    counter bigint NOT NULL DEFAULT 0,
    transports text,
    discoverable boolean NOT NULL DEFAULT false,
    label text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_credential_id ON credentials (credential_id)`,
  `CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials (user_id)`,

  // list_claims — "this account holds this list". See server/db/schema.ts for why
  // it's a join table and not an owner column, and why it stores no secret.
  `CREATE TABLE IF NOT EXISTS list_claims (
    id serial PRIMARY KEY,
    user_id integer NOT NULL,
    list_id integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_list_claims_identity ON list_claims (user_id, list_id)`,
  `CREATE INDEX IF NOT EXISTS idx_list_claims_user ON list_claims (user_id)`,

  ];
