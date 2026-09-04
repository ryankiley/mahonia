// Drizzle schema. Works on PGlite (local dev) and Neon (prod) — driver-agnostic.
//
// Design: a list's CONTENT (folders + items) lives in a single JSONB `data`
// column, and the same op-reducer (shared/ops.ts) applies mutations on both the
// client (optimistic) and the server (authoritative) — so they can't drift.
// Weight rollups are cached as columns (see the note on them below: nothing sorts
// on them since the feed went, but they're the cheap shape any list-of-lists
// query wants). We never query items relationally in v1 (the catalog is a
// separate Phase-2 table), so JSONB is the right fit and keeps sync semantics in
// one place.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ListData } from "../../shared/types";
import type { FullSnap, ListDiff } from "../../shared/snapshotDiff";

// A snapshot row's JSONB: a full payload (`kind:'base'`) or a reverse-delta (`kind:'diff'`).
type SnapshotPayload = FullSnap | ListDiff;

export const lists = pgTable(
  "lists",
  {
    // internal id — NEVER exposed in a URL or API response
    id: serial("id").primaryKey(),
    publicSlug: text("public_slug").notNull(),
    // sha256(editToken) hex — the write capability; raw token never stored
    editTokenHash: text("edit_token_hash").notNull(),
    // short Crockford base32 read capability (the /s/ link)
    shareCode: text("share_code").notNull(),
    title: text("title").notNull().default("Untitled list"),
    description: text("description"),
    displayUnit: text("display_unit").notNull().default("g"),
    // optional link to the route this list was packed for (any http(s) URL, stored
    // normalized); trail_label overrides the name derived from the URL's path
    trailUrl: text("trail_url"),
    trailLabel: text("trail_label"),
    // route length in metres — typed, not fetched (shared/trailDistance.ts)
    trailDistanceM: integer("trail_distance_m"),
    // "km" | "mi"; null = miles (shared/trailDistance.ts)
    trailDistanceUnit: text("trail_distance_unit"),
    // the route's shape, read off a GPX — public, like the rest of the trail meta
    trailProfile: text("trail_profile"),
    trailAscentM: integer("trail_ascent_m"),
    trailDescentM: integer("trail_descent_m"),
    // the route's SHAPE, as an encoded polyline — the app's only stored geography, and
    // NEVER served on a read path (see rowToSnapshot/withOwnerOnly)
    routeGeometry: text("route_geometry"),
    // when the trip is. TEXT holding `YYYY-MM-DD`, not a date/timestamptz column: a
    // trip's dates are calendar dates, and a timestamp type would drag a timezone
    // into a value that has none — round-tripping "Aug 4" into "Aug 3" for anyone
    // west of UTC. The reducer validates the shape (shared/ops.ts).
    startDate: text("start_date"),
    endDate: text("end_date"),
    // folders + items (the op-reducer's state)
    data: jsonb("data").$type<ListData>().notNull(),
    // cached rollups, recomputed on every write. Nothing reads them since the feed
    // indexes went (below); they stay because they're the cheap shape any future
    // list-of-lists query wants, and computing them is already on the write path.
    baseWeightMg: bigint("base_weight_mg", { mode: "number" }).notNull().default(0),
    wornWeightMg: bigint("worn_weight_mg", { mode: "number" }).notNull().default(0),
    consumableWeightMg: bigint("consumable_weight_mg", { mode: "number" }).notNull().default(0),
    totalWeightMg: bigint("total_weight_mg", { mode: "number" }).notNull().default(0),
    itemCount: integer("item_count").notNull().default(0),
    isPublic: boolean("is_public").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // facets on a published list (closed enums, normalized in shared/discovery.ts).
    // They render on /l and in its unfurl; there is no feed to browse them by.
    tripType: text("trip_type"),
    season: text("season"),
    primaryCategory: text("primary_category"),
    // cheap "most-viewed" signal; best-effort bumped on public reads (/l)
    viewCount: integer("view_count").notNull().default(0),
    // withheld from public discovery pending review (spam heuristic or a user
    // report). Distinct from `status`: a flagged list stays active, so the OWNER
    // keeps edit + share access — only the public /l address is withheld.
    flagged: boolean("flagged").notNull().default(false),
    // The byline on the read views — who MADE the list.
    //
    // Set ONCE at creation and never re-pointed by claiming: an edit link is
    // shared, so "who else holds this" is a different question from "who wrote
    // it", and letting a claim rewrite authorship would let anyone with the link
    // put their name on someone else's list.
    authorUserId: integer("author_user_id"),
    // optional recovery (generated phrase only); not used yet
    claimPhraseHash: text("claim_phrase_hash"),
    // when this list was last auto-snapshotted (drives the snapshot throttle from
    // the in-hand row, so the hot mutate path needs no extra query)
    lastSnapshotAt: timestamp("last_snapshot_at", { withTimezone: true }),
    // optimistic concurrency + live-sync counter
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("active"), // active | hidden | removed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // partial unique indexes so soft-deleted rows don't block reuse
    uniqueIndex("idx_lists_edit_token")
      .on(t.editTokenHash)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex("idx_lists_share_code")
      .on(t.shareCode)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex("idx_lists_slug")
      .on(t.publicSlug)
      .where(sql`${t.deletedAt} is null`),
    // NO feed indexes. Three partial indexes used to sit here — a lightest-packs
    // leaderboard, a recency sort, and browse-by-trip-type — for a public feed that
    // was never built (there has never been a listPublicFeed query to serve). They
    // were dropped deliberately: a public directory of user-made lists is thin,
    // near-duplicate content and a standing moderation job, and sharing already
    // works without one (`/s/{code}` opens for anyone, no account, with its own
    // social card). Publishing itself STAYS — see isPublic above.
    // the nightly reap's scan — abandoned near-empty drafts, over the updated_at
    // range (the query takes no order).
    index("idx_lists_reap")
      .on(t.updatedAt)
      .where(sql`${t.status} = 'active' and ${t.deletedAt} is null and ${t.itemCount} <= 1`),
    // the purge's scan — the OPPOSITE condition to every partial index above, so it
    // needs its own.
    index("idx_lists_purge").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
  ],
);

export type ListRow = typeof lists.$inferSelect;

// ---------------------------------------------------------------------------
// catalog_items — the curated, *cited* gear-weight spine (Phase 2).
//
// Unlike a list's JSONB content, the catalog is queried RELATIONALLY (fuzzy
// autocomplete, usage ranking, wiki corrections), so it's a normalized table.
// Every seeded row carries a real citation (`source_url`) and a provenance
// (`weight_source`) — provenance is the product's trust moat, so it's required.
//
// Fuzzy search uses pg_trgm's word_similarity(). pg_trgm is available on Neon
// but NOT on local PGlite (its WASM build doesn't ship the extension unless
// loaded into the constructor, which we don't touch), so the extension + GIN
// trigram index are created at runtime ONLY on Neon by `ensureCatalogSchema()`
// in server/utils/catalog.ts; on PGlite the search endpoint falls back to the
// shared JS trigram ranker `searchCatalogLocal` (shared/catalogSearch.ts) — the
// same ranking the offline client uses, so recall can't drift. The GIN index
// declared below is schema-fidelity metadata only: it is never run by the
// raw-DDL `ensureSchema()` path the live app uses, and the Neon query filters +
// orders on the word_similarity() function directly, deliberately forgoing
// gin_trgm_ops (the catalog is small + bounded, so the seq scan is cheap).
// ---------------------------------------------------------------------------
export const catalogItems = pgTable(
  "catalog_items",
  {
    id: serial("id").primaryKey(),
    brand: text("brand"), // company / maker (nullable: generic items like "Smartwater bottle")
    name: text("name").notNull(), // product name
    variant: text("variant"), // size / temp / capacity that changes the weight
    description: text("description"),
    // Default generic label ("tent", "trekking poles") — auto-fills a list item's
    // commonName on pick and via live-resolve. Generated per row (seed/common-names.json).
    commonName: text("common_name"),
    // shelter|sleep|pack|cook|water|clothing|electronics|firstaid|consumable|other
    categoryHint: text("category_hint"),
    // Extra searchable words (category noun + locale/synonym aliases), derived at
    // seed time from name + category_hint — see scripts/searchTerms.ts. Folded into
    // the fuzzy match so "tent" finds a "Copper Spur" and "rucksack" a "backpack".
    searchTerms: text("search_terms"),
    weightMg: bigint("weight_mg", { mode: "number" }).notNull(),
    // Food energy for ONE unit (the calorie twin of weight_mg) — cited research,
    // food rows only; null everywhere else. A pick pre-fills the row's kcal with it.
    kcal: integer("kcal"),
    // REQUIRED provenance — forces every row to declare where its weight came from
    weightSource: text("weight_source").notNull(), // manufacturer|measured|community|imported
    sourceUrl: text("source_url"), // the citation (manufacturer spec page preferred)
    productUrl: text("product_url"), // optional buy/official link, distinct from the citation
    imageUrl: text("image_url"), // optional, external — we don't host images
    msrpCents: integer("msrp_cents"),
    currency: text("currency"),
    verified: boolean("verified").notNull().default(false), // owner-curated trust
    usageCount: integer("usage_count").notNull().default(0), // ranks autocomplete
    status: text("status").notNull().default("active"), // active|merged|removed
    mergedIntoId: integer("merged_into_id"), // when status='merged', the survivor row
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "catalog_weight_source_ck",
      sql`${t.weightSource} in ('manufacturer','measured','community','imported')`,
    ),
    check("catalog_status_ck", sql`${t.status} in ('active','merged','removed')`),
    // identity for idempotent upsert — coalesce so NULL brand/variant compare equal
    uniqueIndex("idx_catalog_identity").on(
      sql`coalesce(${t.brand},'')`,
      t.name,
      sql`coalesce(${t.variant},'')`,
    ),
    // autocomplete ranking: verified first, then most-used
    index("idx_catalog_rank")
      .on(t.verified.desc(), t.usageCount.desc())
      .where(sql`${t.status} = 'active'`),
    // fuzzy search (Neon only — see note above; created by ensureCatalogSchema())
    index("idx_catalog_trgm").using(
      "gin",
      sql`(coalesce(${t.brand},'') || ' ' || ${t.name}) gin_trgm_ops`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// catalog_edits — the wiki history (Phase 3). One row per change to a catalog
// weight. No accounts, so we identify a change by the change itself, not a user.
// Every weight change is recorded here so any edit is revertible and the history
// is auditable (powers the recent-changes feed + one-click revert).
//
// Trust-tiered: editing an uncited/community value applies instantly; editing a
// verified value becomes a `proposed` row unless the correction carries a
// citation from a trusted manufacturer/retailer domain (then it auto-applies).
// ---------------------------------------------------------------------------
export const catalogEdits = pgTable(
  "catalog_edits",
  {
    id: serial("id").primaryKey(),
    catalogItemId: integer("catalog_item_id").notNull(),
    oldWeightMg: bigint("old_weight_mg", { mode: "number" }).notNull(),
    newWeightMg: bigint("new_weight_mg", { mode: "number" }).notNull(),
    sourceUrl: text("source_url"), // citation; validated against a domain allowlist for auto-promote
    reason: text("reason"),
    status: text("status").notNull().default("applied"), // applied|proposed|reverted|rejected
    confirmations: integer("confirmations").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "catalog_edit_status_ck",
      sql`${t.status} in ('applied','proposed','reverted','rejected')`,
    ),
    index("idx_catalog_edits_item").on(t.catalogItemId, t.createdAt.desc()),
    index("idx_catalog_edits_recent").on(t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// catalog_candidates — community intake staging (Phase 3). When a user TYPES an
// item into a list that isn't from the catalog, one observation is staged here.
// A nightly job promotes a norm_key seen on >= K distinct lists into a real
// (community, unverified) catalog_items row using the median observed weight.
// Staged (not added on sight) so the cited spine stays clean; one row per
// (norm_key, list_id) so the distinct-list count and median are plain aggregates.
// ---------------------------------------------------------------------------
export const catalogCandidates = pgTable(
  "catalog_candidates",
  {
    id: serial("id").primaryKey(),
    normKey: text("norm_key").notNull(), // normalized "brand name" for grouping
    rawBrand: text("raw_brand"),
    rawName: text("raw_name").notNull(),
    listId: integer("list_id").notNull(), // INTERNAL list id — distinctness only, never exposed
    weightMg: bigint("weight_mg", { mode: "number" }), // nullable: user may type no weight
    classification: text("classification"), // base|worn|consumable|null → category_hint
    promotedIntoId: integer("promoted_into_id"), // set once promoted/merged → stop recounting
    rejectedAt: timestamp("rejected_at", { withTimezone: true }), // filtered out → stop recounting
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one observation per (item, list) — re-typing on the same list updates, never duplicates
    uniqueIndex("idx_candidate_identity").on(t.normKey, t.listId),
    // grouping scan: un-processed candidates by norm_key
    index("idx_candidate_open")
      .on(t.normKey)
      .where(sql`${t.promotedIntoId} is null and ${t.rejectedAt} is null`),
  ],
);

// ---------------------------------------------------------------------------
// list_snapshots — periodic recovery points for the shared-edit-link model.
// An edit link is a SHARED capability, so a clumsy/malicious editor can wreck a
// list; a throttled snapshot of the pre-mutation state (plus one before any
// restore) lets the owner roll back. Capped + pruned per list (see listRepo).
// ---------------------------------------------------------------------------
export const listSnapshots = pgTable(
  "list_snapshots",
  {
    id: serial("id").primaryKey(),
    listId: integer("list_id").notNull(),
    // `base` rows hold a full payload (meta + reducer content); `diff` rows hold a
    // reverse-delta (ListDiff) from the immediately-newer snapshot. Only the NEWEST
    // per list is a base, so snapshots cost a fraction of a full copy. See
    // shared/snapshotDiff.ts.
    kind: text("kind").notNull().default("base"),
    snapshot: jsonb("snapshot").$type<SnapshotPayload>().notNull(),
    // reconstructed item count, cached so the snapshots list doesn't reconstruct
    itemCount: integer("item_count").notNull().default(0),
    version: integer("version").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_list_snapshots_list").on(t.listId, t.createdAt.desc())],
);

// Favicons for trail-link hosts, cached ONCE PER HOST rather than per list. Every list
// pointing at alltrails.com shares this row, so a popular site costs one fetch a month
// however many lists link to it — and the refresh sweep walks a handful of hosts instead
// of thousands of rows. Stored as a data: URL so a strict img-src 'self' data: never has
// to loosen (see config/security.ts).
export const trailFavicons = pgTable(
  "trail_favicons",
  {
    // hostname, lowercased, www. stripped — matches TrailLink.host
    host: text("host").primaryKey(),
    // null = fetched and there wasn't a usable icon. A NEGATIVE row still counts as
    // fetched: it's what stops a dead host being re-fetched on every subsequent save.
    dataUrl: text("data_url"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // the refresh sweep's scan: stalest host first (refreshStaleFavicons)
  (t) => [index("idx_trail_favicons_stale").on(t.fetchedAt)],
);

// ---------------------------------------------------------------------------
// vaults + vault_items — your own gear locker, owned by an ACCOUNT.
//
// The one part of Mahonia that asks you to sign in. Lists stay link-owned, because
// a link owning a thing is the product's whole mental model — but a vault is the
// durable record of what you OWN, and the thing you'd most hate to lose to a
// cleared browser. Signing in on another device is what carries it there; there is
// no transfer token and no second link to keep.
//
// It was link-owned first, and the cost of that ("lose the link and you lose the
// gear") is what an account buys out. The migration is in server/utils/vaultSchema
// — a gear from that era has a null user_id and is unreachable by design, because
// inventing an owner would hand someone else's gear to whoever signed in first.
// ---------------------------------------------------------------------------
export const vaults = pgTable(
  "vaults",
  {
    // internal id — NEVER exposed in a URL or API response
    id: serial("id").primaryKey(),
    // The owner. A vault belongs to an ACCOUNT, unlike a list, which belongs to
    // whoever holds its edit link — see requireVault for why the two differ.
    //
    // Nullable only so the column can be added to a table that already has rows;
    // every vault minted since is owned. A row left null is an orphan from the
    // link-owned era and is unreachable by design.
    userId: integer("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // bumped on use, so an abandoned vault can be reaped on the same schedule as
    // an abandoned list rather than accumulating forever
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // Soft-delete, set by the reaper and cleared by requireVault — so a vault whose
    // owner comes back after the stale window is REVIVED by being used rather than
    // being already gone.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // one vault per account; also the conflict target for lazy minting
    uniqueIndex("idx_vaults_user").on(t.userId),
    // the reaper's scan: live vaults, oldest-seen first
    index("idx_vaults_stale").on(t.lastSeenAt).where(sql`${t.deletedAt} is null`),
    // the purge's scan — the opposite condition, so it can't share the index above
    index("idx_vaults_purge").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
  ],
);

/**
 * A vault's folders. Its own table rather than a text label on the item, because
 * these carry state of their own — an order you can drag — which a label has
 * nowhere to keep. Name is unique per vault so capture can find-or-create by the
 * list folder's name without ending up with three "Shelter"s.
 *
 * Deliberately NOT a mirror of the list Folder type: colorKey and
 * defaultClassification are facts about how a LIST presents and classifies its
 * rows, and a vault row carries its own classification already.
 */
export const vaultFolders = pgTable(
  "vault_folders",
  {
    id: serial("id").primaryKey(),
    vaultId: integer("vault_id").notNull(),
    name: text("name").notNull(),
    // drag order on /vault; ties break on id so the order is always total
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idx_vault_folder_name").on(t.vaultId, t.name)],
);


// Relational, not JSONB (unlike a list's content): the vault is QUERIED — fuzzy
// autocomplete while building a list, sorted browsing on /vault — which is the
// same reason catalog_items is a real table.
//
// Identity is `norm_key` (folded brand + name + variant — see shared/vault.ts),
// unique per vault, so re-adding the same tent to a tenth list updates one row
// instead of growing a tenth. Weight is LAST-WRITE-WINS: your most recent entry
// is your current truth about your own gear, and correcting a weight in any list
// should correct the vault rather than fork it.
//
// `removed_at` is a TOMBSTONE, not a delete. Capture is automatic, so a hard
// delete would be undone by the next list that still contains the item —
// removing something has to mean "stop offering me this", and only a row that
// outlives the capture can say so. A later capture of a tombstoned key leaves it
// tombstoned; explicitly re-adding the item from a list clears it.
export const vaultItems = pgTable(
  "vault_items",
  {
    id: serial("id").primaryKey(),
    vaultId: integer("vault_id").notNull(),
    normKey: text("norm_key").notNull(),
    brand: text("brand"),
    name: text("name").notNull(),
    variant: text("variant"),
    commonName: text("common_name"),
    weightMg: bigint("weight_mg", { mode: "number" }).notNull().default(0),
    classification: text("classification"), // base|worn|consumable (null = unset)
    // Food energy per unit, whole kcal — the calorie twin of weight_mg, so the
    // trail food you pack every trip comes back with its calories. Null = unknown.
    kcal: integer("kcal"),
    catalogItemId: integer("catalog_item_id"), // set when the row came from a catalog pick
    productUrl: text("product_url"),
    // The holder's grouping. Null = unfiled, which is also every row's starting
    // state and where a row lands again if its folder is deleted.
    folderId: integer("folder_id"),
    // The pins — which fields you've corrected by hand on /gear, so capture leaves
    // them alone (see captureVaultItems and the DDL comment in utils/vaultSchema).
    // brand/name/variant share one flag: they are one SPELLING of one identity, and
    // the merge rewrites all three together or none.
    namePinned: boolean("name_pinned").notNull().default(false),
    weightPinned: boolean("weight_pinned").notNull().default(false),
    commonNamePinned: boolean("common_name_pinned").notNull().default(false),
    classificationPinned: boolean("classification_pinned").notNull().default(false),
    kcalPinned: boolean("kcal_pinned").notNull().default(false),
    productUrlPinned: boolean("product_url_pinned").notNull().default(false),
    // how many distinct captures have landed here — ranks the autocomplete, the
    // vault's analogue of catalog_items.usage_count
    timesSeen: integer("times_seen").notNull().default(1),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "vault_classification_ck",
      sql`${t.classification} is null or ${t.classification} in ('base','worn','consumable')`,
    ),
    // one row per piece of gear per vault — the upsert target
    uniqueIndex("idx_vault_identity").on(t.vaultId, t.normKey),
    // the /vault browse + the autocomplete's candidate pool: a vault's live rows,
    // most-recently-used first
    index("idx_vault_recent")
      .on(t.vaultId, t.lastUsedAt.desc())
      .where(sql`${t.removedAt} is null`),
  ],
);

// ---------------------------------------------------------------------------
// THE OPTIONAL ACCOUNT LAYER
//
// Nothing below is required to use Mahonia. A list opens by its edit link and a
// vault by its vault link, both unchanged. An account does one job: it REMEMBERS
// those links, so they don't have to be carried between devices by hand.
//
// Identity is an email address and nothing else — no name, no password, no
// profile. Sign-in is a single-use emailed link, so there is no password to
// hash, leak, or reset, and the row below is the entire footprint of an account.
// A passkey is added later, to an account already signed in, and stores only a
// PUBLIC key.
// ---------------------------------------------------------------------------
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    // stored already-lowercased (normalizeEmail) so the unique index is the
    // case-insensitive one users expect without needing citext
    // Required, on every signup path. The passkey identifies you; this is the way
    // BACK IN when every authenticator is gone — see accountSchema.ts.
    email: text("email").notNull(),
    // OPTIONAL, and the only thing about an account that is ever public. Set it and
    // your public lists carry a byline; leave it and they stay anonymous, which is
    // the default. Deliberately not derived from the email — an address is private
    // and must never be shown to anyone but its owner.
    displayName: text("display_name"),
    // Whether anyone has ever proved they hold this address. False for an account
    // made by passkey signup, where the address is only a claim until a link sent
    // to it comes back; true for one made by the magic-link path, where the round
    // trip through the inbox is the signup. Redeeming a link for an account still
    // sitting at false evicts every passkey and session older than that link —
    // see accountSchema.ts for why, and authSession.ts for the eviction itself.
    emailVerified: boolean("email_verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idx_users_email").on(t.email)],
);

// A pending magic link. Short-lived and single-use: `consumedAt` is stamped the
// moment it's redeemed, so a link forwarded or replayed from an inbox is inert.
// Only the sha256 of the token is stored — a database read can't mint a sign-in.
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: serial("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: integer("user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_auth_tokens_hash").on(t.tokenHash),
    // the sweep that reaps expired/consumed links
    index("idx_auth_tokens_expiry").on(t.expiresAt),
  ],
);

// A signed-in browser. The cookie carries a high-entropy random value; like the
// edit token and the magic link, only its sha256 is stored, so the session table
// is not a set of usable credentials. Sliding expiry (see authSession.ts).
export const sessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: integer("user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_sessions_hash").on(t.tokenHash),
    // "sign out everywhere" + the expiry sweep
    index("idx_sessions_user").on(t.userId),
    index("idx_sessions_expiry").on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// credentials — passkeys (WebAuthn).
//
// The second way into an account, and the better one: a passkey is bound to this
// site's origin, so it can't be phished, and signing in is a fingerprint or a PIN
// instead of a round trip through an inbox. The magic link stays as the way to
// GET a passkey in the first place (and to recover if you lose your devices), so
// the two are complements rather than alternatives.
//
// Nothing secret is stored here. A passkey's private half never leaves the
// authenticator; `public_key` is what verifies its signatures, and is useless to
// an attacker who steals it. That makes this table strictly less sensitive than a
// password hash would be.
// ---------------------------------------------------------------------------
export const credentials = pgTable(
  "credentials",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    // base64url, as WebAuthn hands it to us — the authenticator's handle for this key
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(), // base64url COSE key
    // The authenticator's signature counter. Some authenticators keep one and it
    // must never go backwards (a decrease means a cloned key); many modern
    // passkeys report a constant 0, which is normal and not a red flag.
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    transports: text("transports"), // JSON array: how to reach this key (usb, internal, hybrid…)
    // whether the key can be found without naming the account first — what makes
    // "sign in with a passkey" work with no email typed at all
    discoverable: boolean("discoverable").notNull().default(false),
    label: text("label"), // human-set name, so a list of keys is meaningful
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    // a credential id is globally unique; the unique index is also what stops the
    // same key being registered twice
    uniqueIndex("idx_credentials_credential_id").on(t.credentialId),
    index("idx_credentials_user").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// list_claims — "this account holds this list", so lists follow you off the
// device that made them.
//
// NOT an ownership column on `lists`. An edit link is a SHARED capability by
// design: you can hand it to a walking partner and you both edit. A single
// `lists.user_id` would make the first person to sign in the owner and quietly
// demote everyone else, which is a change to how lists work — and nobody asked
// for that. A join table says only what's true: several accounts may each hold
// the same list, exactly as several browsers may each hold its token.
//
// A claim stores NO SECRET. It doesn't need to: `lists.edit_token_hash` is
// already the lookup key for every edit path, so a claim + the list row is
// enough to authorise, and the raw token is never written down anywhere. Two
// consequences fall out for free: rotating a list's edit token doesn't break its
// claims (the hash is re-read from the row each time), and a database dump still
// yields no usable write capability.
// ---------------------------------------------------------------------------
export const listClaims = pgTable(
  "list_claims",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    listId: integer("list_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // claiming the same list twice is a no-op, not a second row
    uniqueIndex("idx_list_claims_identity").on(t.userId, t.listId),
    // "my lists" for a signed-in user
    index("idx_list_claims_user").on(t.userId),
  ],
);