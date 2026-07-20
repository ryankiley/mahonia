// Drizzle schema. Works on PGlite (local dev) and Neon (prod) — driver-agnostic.
//
// Design: a list's CONTENT (folders + items) lives in a single JSONB `data`
// column, and the same op-reducer (shared/ops.ts) applies mutations on both the
// client (optimistic) and the server (authoritative) — so they can't drift.
// Weight rollups are cached as columns for the public-feed leaderboard sort.
// We never query items relationally in v1 (the catalog is a separate Phase-2
// table), so JSONB is the right fit and keeps sync semantics in one place.

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
    // folders + items (the op-reducer's state)
    data: jsonb("data").$type<ListData>().notNull(),
    // cached rollups (feed sort only; recomputed on every write)
    baseWeightMg: bigint("base_weight_mg", { mode: "number" }).notNull().default(0),
    wornWeightMg: bigint("worn_weight_mg", { mode: "number" }).notNull().default(0),
    consumableWeightMg: bigint("consumable_weight_mg", { mode: "number" }).notNull().default(0),
    totalWeightMg: bigint("total_weight_mg", { mode: "number" }).notNull().default(0),
    itemCount: integer("item_count").notNull().default(0),
    isPublic: boolean("is_public").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // public-feed facets (closed enums, normalized in shared/discovery.ts)
    tripType: text("trip_type"),
    season: text("season"),
    primaryCategory: text("primary_category"),
    // cheap "most-viewed" signal for the feed; best-effort bumped on public reads
    viewCount: integer("view_count").notNull().default(0),
    // withheld from the public feed pending review (spam heuristic or a user
    // report). Distinct from `status`: a flagged list stays active, so the OWNER
    // keeps edit + share access — only public discovery is withheld.
    flagged: boolean("flagged").notNull().default(false),
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
    // feed sort: lightest-packs leaderboard (base weight asc)
    index("idx_lists_feed")
      .on(t.baseWeightMg)
      .where(sql`${t.isPublic} and ${t.status} = 'active' and ${t.deletedAt} is null`),
    // feed sort: recent (published_at desc)
    index("idx_lists_feed_recent")
      .on(t.publishedAt.desc())
      .where(sql`${t.isPublic} and ${t.status} = 'active' and ${t.deletedAt} is null`),
    // browse-by-trip-type (the default feed): trip then recency
    index("idx_lists_feed_trip")
      .on(t.tripType, t.publishedAt.desc())
      .where(sql`${t.isPublic} and ${t.status} = 'active' and ${t.deletedAt} is null`),
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
    // seed time from name + category_hint — see shared/searchTerms.ts. Folded into
    // the fuzzy match so "tent" finds a "Copper Spur" and "rucksack" a "backpack".
    searchTerms: text("search_terms"),
    weightMg: bigint("weight_mg", { mode: "number" }).notNull(),
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
