// Catalog (Phase 2) — schema bootstrap + fuzzy autocomplete search.
//
// Kept out of the hot lists path in db.ts on purpose. The catalog table DDL is
// single-sourced here (CATALOG_DDL) and spread into db.ts's idempotent local
// DDL, so the dev server auto-creates it; the seed script and search endpoint
// also call ensureCatalogSchema() so they work on Neon (where db.ts applies
// schema via migrations, not on the request path) regardless of migration state.
//
// FUZZY SEARCH — pg_trgm vs ILIKE/JS, decided empirically:
//   • Neon (prod): pg_trgm is available → a GIN trigram index + word_similarity
//     give typo-tolerant matching ("zpacks duplx" → Zpacks Duplex) in SQL.
//   • PGlite (local dev): `CREATE EXTENSION pg_trgm` FAILS ("extension not
//     available") because PGlite only exposes contrib extensions loaded into its
//     constructor, which we don't touch (it's the shared lists DB path). So we
//     load the (small, bounded) active catalog and rank it in JS with a trigram
//     coverage score — same typo tolerance, zero extension. The set of gear
//     people actually carry is small by design, so this stays cheap locally.
// Engine is detected via DATABASE_URL, the same signal db.ts uses.

import { MAX_URL_LEN, safeUrl } from "../../shared/trailLink";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { catalogEdits, catalogItems } from "../db/schema";
import { itemDisplayName } from "../../shared/weights";
import { enoughToSearch, foldForSearch, foldWidth } from "../../shared/searchText";
import { UNIT_WEIGHT_MAX_MG, isCatalogId } from "../../shared/ops";
import { memoized } from "./memoize";
import { runDdl } from "./ddl";
import { toIso } from "./time";
import type { Db } from "./db";
import {
  SEARCH_LIMIT,
  SIM_THRESHOLD,
  rankCandidates, type CatalogSearchResult,
  type LocalCatalogRow,
toCatalogResult } from "../../shared/catalogSearch";
import { WEIGHT_SOURCES, type RecentChange } from "../../shared/types";

/** One label column of the VERIFIED active rows, distinct and sorted, blanks dropped:
 *  the read behind both vocabularies below. Labels only, never a product row. */
async function verifiedLabels(
  db: Db,
  col: typeof catalogItems.commonName | typeof catalogItems.brand,
): Promise<string[]> {
  await ensureCatalogSchema(db);
  const rows = await db.selectDistinct({ label: col })
    .from(catalogItems)
    .where(and(eq(catalogItems.status, "active"), eq(catalogItems.verified, true)))
    .orderBy(col);
  return rows.flatMap(({ label }) => label?.trim() ? [label] : []);
}

/**
 * The gear-type vocabulary the editor's datalist suggests (#382), without downloading a
 * product row: the distinct gear types of the VERIFIED active rows — the seeded ones,
 * whose labels scripts/gearTypes.ts sentence-cases and de-drifts at build. A community
 * row promoted from typed items keeps its gear type as people typed it (candidates.ts),
 * so reading those here would offer "tent", "Tents" and "shelter" back as suggestions:
 * the drift the suggestions exist to stop.
 */
export const catalogGearTypes = (db: Db): Promise<string[]> => verifiedLabels(db, catalogItems.commonName);

/** Every maker the verified catalog names, distinct and sorted: the vocabulary My Gear's
 *  edit dialog offers under its Brand field, the way catalogGearTypes feeds Gear type.
 *  Labels only, the same verified-and-active rows. */
export const catalogBrands = (db: Db): Promise<string[]> => verifiedLabels(db, catalogItems.brand);

const isNeon = () => Boolean(process.env.DATABASE_URL);

// Safe on BOTH PGlite and Neon. Single source of truth; also spread into db.ts's
// local idempotent DDL. The pg_trgm GIN index is created separately (Neon only).
export const CATALOG_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS catalog_items (
    id serial PRIMARY KEY,
    brand text,
    name text NOT NULL,
    variant text,
    category_hint text,
    weight_mg bigint NOT NULL,
    weight_source text NOT NULL CHECK (weight_source IN (${WEIGHT_SOURCES.map((s) => `'${s}'`).join(",")})),
    source_url text,
    product_url text,
    verified boolean NOT NULL DEFAULT false,
    usage_count integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','removed')),
    merged_into_id integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // search_terms — derived noun + locale/synonym aliases (scripts/searchTerms.ts),
  // folded into the fuzzy match. Added via ALTER so existing tables gain it too
  // (CREATE TABLE IF NOT EXISTS above is a no-op once the table exists).
  `ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS search_terms text`,
  // common_name — the generated default label ("tent", "trekking poles") a pick
  // pre-fills onto a list item. ALTER so existing tables gain it (like search_terms).
  `ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS common_name text`,
  // kcal — cited per-unit food energy (food rows only; null elsewhere). ALTER so
  // existing tables self-migrate, same as search_terms/common_name.
  `ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS kcal integer`,
  // verified_by + source_quote — an in-app verification (verify_catalog_item): the
  // admin account behind it, and the maker's words for the weight. Null on every
  // seeded and community row; see schema.ts for what verified_by means to the seed.
  `ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS verified_by integer`,
  `ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS source_quote text`,
  // Columns from the first version that nothing ever read or wrote, dropped where an
  // older database still has them.
  `ALTER TABLE catalog_items DROP COLUMN IF EXISTS description, DROP COLUMN IF EXISTS image_url, DROP COLUMN IF EXISTS msrp_cents, DROP COLUMN IF EXISTS currency`,
  // identity for idempotent upsert — coalesce so NULL brand/variant compare equal
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_identity ON catalog_items ((coalesce(brand,'')), name, (coalesce(variant,'')))`,
  // autocomplete ranking: verified first, then most-used
  `CREATE INDEX IF NOT EXISTS idx_catalog_rank ON catalog_items (verified DESC, usage_count DESC) WHERE status = 'active'`,
  // catalog_edits — the wiki history (Phase 3); see schema.ts for the rationale
  `CREATE TABLE IF NOT EXISTS catalog_edits (
    id serial PRIMARY KEY,
    catalog_item_id integer NOT NULL,
    old_weight_mg bigint NOT NULL,
    new_weight_mg bigint NOT NULL,
    source_url text,
    reason text,
    status text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','proposed','reverted','rejected')),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  // a first-version column nothing ever read, dropped where it still exists
  `ALTER TABLE catalog_edits DROP COLUMN IF EXISTS confirmations`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_edits_item ON catalog_edits (catalog_item_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_edits_recent ON catalog_edits (created_at DESC)`,
  // undo — an in-app verification's prior row fields, for revert_catalog_edit (schema.ts)
  `ALTER TABLE catalog_edits ADD COLUMN IF NOT EXISTS undo jsonb`,
];

// Neon ships pg_trgm and unaccent; PGlite doesn't (see the file header), so the
// extensions and the GIN trigram index that power fuzzy autocomplete are Neon-only.
// unaccent folds diacritics (ä→a) at query time so an accented brand ("Fjällräven")
// matches its plain spelling — mirrors the fold in shared/catalogSearch.ts's
// trigrams(). It is used in WHERE/ORDER expressions, not an index, so its STABLE
// volatility is fine.
const CATALOG_NEON_DDL: string[] = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE EXTENSION IF NOT EXISTS unaccent`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_trgm ON catalog_items USING gin ((coalesce(brand,'') || ' ' || name) gin_trgm_ops)`,
];

/** Idempotently create the catalog table + indexes (memoized per process). */
export const ensureCatalogSchema = memoized((db: Db) =>
  runDdl(db, isNeon() ? [...CATALOG_DDL, ...CATALOG_NEON_DDL] : CATALOG_DDL),
);

function normalizeQuery(q: unknown): string {
  return typeof q === "string" ? q.trim() : "";
}

/**
 * Fuzzy autocomplete. Two stages that share ONE ranking (shared/catalogSearch.ts):
 * SQL/scan does coarse recall, then rankCandidates() does the fine ordering
 * (relevance-tier cascade: tier → verified → usage_count → similarity → id, then the kind-of-gear diversity cap) and
 * caps to `limit`. pg_trgm recall on Neon; whole-table JS on PGlite (see file
 * header). Keeping the order in rankCandidates() — not in SQL — is what makes the
 * "prod and offline must never diverge" invariant real instead of hand-mirrored.
 */
export async function searchCatalog(
  db: Db,
  rawQuery: unknown,
  limit = SEARCH_LIMIT, // same default as the offline ranker — counts can't drift
  // How the ranked rows are cut: by row (the default: what the connector and the
  // candidate dedup read) or by product, each with every version (rankProducts, what
  // the editor's menu asks for). Recall is the same either way.
  rank: typeof rankCandidates = rankCandidates,
): Promise<CatalogSearchResult[]> {
  const q = normalizeQuery(rawQuery);
  if (!enoughToSearch(q)) return []; // 1 char is too noisy for trigrams, unless it is a word

  if (isNeon()) {
    // The width fold the JS ranker applies, done here too: unaccent() and pg_trgm's
    // case fold cover accents and case, but "ＭＳＲ" is three letters Postgres has
    // never seen. STAGE 2 folds the raw query itself, so only the recall needs this.
    const wide = foldWidth(q);
    // STAGE 1 — recall only. word_similarity matches a short query against the best
    // extent of a longer name — the right metric for autocomplete fragments. We
    // DON'T use the `<%` operator: its threshold is the GUC
    // pg_trgm.word_similarity_threshold, which defaults to 0.6 — ~2x stricter than
    // SIM_THRESHOLD (0.3), so typo'd/partial queries ("kawa 55", "palante") that
    // match locally returned nothing in prod. Filtering on the function with our own
    // threshold makes prod recall match local. The catalog is small + bounded, so
    // the seq scan (we forgo the gin_trgm_ops index this way) is cheap. Bound params
    // are injection-safe.
    // Match target includes search_terms (derived noun + locale/synonym aliases)
    // so a category word ("tent") or a regional variant ("rucksack") hits a row
    // whose brand+name never contains it. Mirrors shared/catalogSearch.ts.
    // Both query and target are unaccent()'d so a plain-typed brand finds its
    // accented spelling and vice versa (mirrors trigrams()' diacritic fold).
    // We fetch EVERY gated row (no ORDER BY / LIMIT here) and carry usage_count
    // through, so STAGE 2's rankCandidates() reorders + caps in JS. Truncating the
    // recall to a top-N-by-similarity pool is NOT safe: common-token queries ("pro",
    // "tent") tie hundreds of rows at similarity 1.0, so a similarity+id cut is
    // arbitrary among the ties and can drop a verified/high-usage row the tier
    // re-rank would have surfaced — diverging from the offline path. The gate bounds
    // the row count on the small, bounded catalog (same bet the offline path makes
    // by loading the whole active table), so fetching all gated rows is cheap and
    // makes Neon ≡ PGlite ≡ offline by construction.
    const res = await db.execute(sql`
      select id, brand, name, variant, weight_mg, weight_source, verified, usage_count, search_terms, common_name, category_hint, kcal
      from catalog_items
      where status = 'active'
        and word_similarity(unaccent(${wide}), unaccent(coalesce(brand,'') || ' ' || name || ' ' || coalesce(search_terms,''))) >= ${SIM_THRESHOLD}
    `);
    // STAGE 2 — the same JS re-ranker the offline path uses.
    return rank(normalizeRows(res), q, limit);
  }

  // PGlite: load the bounded active catalog and rank in JS — the SAME ranking the
  // offline client uses (rankCandidates is the shared source of truth).
  const rows = await db.select().from(catalogItems).where(eq(catalogItems.status, "active"));
  return rank(rows, q, limit);
}

/**
 * Every active row, in the autocomplete's result shape — the pool the import matcher
 * indexes by exact name (shared/catalogMatch.ts). The same whole-table read the PGlite
 * search path makes: the catalog is small and bounded, and an import is rare.
 */
export async function activeCatalogRows(db: Db): Promise<CatalogSearchResult[]> {
  const rows = await db.select().from(catalogItems).where(eq(catalogItems.status, "active"));
  return rows.map(toCatalogResult);
}

/** One variant of a product, with its citation: what the MCP product tool hands back. */
interface ProductVariant {
  id: number;
  variant: string | null;
  weightMg: number;
  weightSource: string;
  sourceUrl: string | null;
  verified: boolean;
  kcal: number | null;
}
interface CatalogProduct {
  brand: string | null;
  name: string;
  commonName: string | null;
  categoryHint: string | null;
  variants: ProductVariant[];
}

/**
 * One product and every active variant of it, by a row id (its siblings come along)
 * or by brand and name. A product is the rows sharing a folded brand and an
 * exact, case-insensitive name: the identity index is (brand, name, variant), and
 * this is that index minus its last column. Null when nothing matches.
 */
export async function productVariants(
  db: Db,
  ref: { id?: number; brand?: string; name?: string },
): Promise<CatalogProduct | null> {
  let anchor: { brand: string | null; name: string } | undefined;
  if (ref.id) {
    const rows = await db
      .select({ brand: catalogItems.brand, name: catalogItems.name })
      .from(catalogItems)
      .where(and(eq(catalogItems.id, ref.id), eq(catalogItems.status, "active")))
      .limit(1);
    anchor = rows[0];
  } else if (ref.name) {
    anchor = { brand: ref.brand ?? null, name: ref.name };
  }
  if (!anchor) return null;
  const rows = await db
    .select({
      id: catalogItems.id,
      brand: catalogItems.brand,
      name: catalogItems.name,
      variant: catalogItems.variant,
      commonName: catalogItems.commonName,
      categoryHint: catalogItems.categoryHint,
      weightMg: catalogItems.weightMg,
      weightSource: catalogItems.weightSource,
      sourceUrl: catalogItems.sourceUrl,
      verified: catalogItems.verified,
      kcal: catalogItems.kcal,
    })
    .from(catalogItems)
    .where(and(eq(catalogItems.status, "active"), sql`lower(${catalogItems.name}) = lower(${anchor.name})`));
  const wantBrand = foldForSearch(anchor.brand ?? "");
  const siblings = rows
    .filter((r) => foldForSearch(r.brand ?? "") === wantBrand)
    .sort((a, b) => (a.variant ?? "").localeCompare(b.variant ?? "") || a.id - b.id);
  const first = siblings[0];
  if (!first) return null;
  return {
    brand: first.brand,
    name: first.name,
    commonName: first.commonName ?? null,
    categoryHint: first.categoryHint ?? null,
    variants: siblings.map((r) => ({
      id: r.id,
      variant: r.variant,
      weightMg: Number(r.weightMg),
      weightSource: r.weightSource,
      sourceUrl: r.sourceUrl ?? null,
      verified: r.verified,
      kcal: r.kcal ?? null,
    })),
  };
}

/**
 * Active catalog rows by id, in the search result's shape: what a row LINKED to the
 * catalog takes from it (the cited weight, the brand, the variant, the gear type),
 * the way a pick in the editor does. Ids that name nothing are simply absent.
 * `anyStatus` reads retired rows too: a piece linked to one still holds what it gave.
 */
export async function catalogRowsById(db: Db, ids: readonly number[], anyStatus = false): Promise<Map<number, CatalogSearchResult>> {
  const wanted = [...new Set(ids.filter(isCatalogId))];
  if (!wanted.length) return new Map();
  const rows = await db
    .select()
    .from(catalogItems)
    .where(anyStatus ? inArray(catalogItems.id, wanted) : and(inArray(catalogItems.id, wanted), eq(catalogItems.status, "active")));
  return new Map(rows.map((r) => [r.id, toCatalogResult(r)]));
}

/** A merge chain longer than this is a loop, or a catalog nobody should trust. */
const MAX_MERGE_HOPS = 8;

/**
 * The live row each id now means, keyed by the id asked for: the row itself while it is
 * active, the row it was retired into while it is `merged` (followed to the end of the
 * chain), absent when it was retired with no successor or never existed.
 *
 * What every reader of a stored link goes through, because the seed retires rather than
 * deletes (scripts/seedRetire.ts) and a list row keeps the id it was picked under. The
 * common case, every id still active, costs the one query catalogRowsById would.
 */
export async function liveCatalogRows(db: Db, ids: readonly number[]): Promise<Map<number, CatalogSearchResult>> {
  const asked = [...new Set(ids.filter(isCatalogId))];
  const out = new Map<number, CatalogSearchResult>();
  if (!asked.length) return out;
  await ensureCatalogSchema(db);
  const byId = new Map<number, typeof catalogItems.$inferSelect>();
  let want = asked;
  for (let hop = 0; want.length && hop <= MAX_MERGE_HOPS; hop++) {
    const rows = await db.select().from(catalogItems).where(inArray(catalogItems.id, want));
    for (const r of rows) byId.set(r.id, r);
    want = [
      ...new Set(
        rows.flatMap((r) =>
          r.status === "merged" && isCatalogId(r.mergedIntoId) && !byId.has(r.mergedIntoId) ? [r.mergedIntoId] : [],
        ),
      ),
    ];
  }
  for (const id of asked) {
    let row = byId.get(id);
    for (let hop = 0; row?.status === "merged" && hop <= MAX_MERGE_HOPS; hop++) {
      row = isCatalogId(row.mergedIntoId) ? byId.get(row.mergedIntoId) : undefined;
    }
    if (row?.status === "active") out.set(id, toCatalogResult(row));
  }
  return out;
}

/**
 * Increment usage_count for catalog rows that were just added to a list. This is
 * what makes autocomplete self-improve: the gear people actually carry floats to
 * the top of the ranking. Best-effort + bounded; works on PGlite + Neon.
 */
export async function bumpUsage(db: Db, ids: number[]): Promise<void> {
  const clean = [...new Set(ids.filter(isCatalogId))].slice(0, 50);
  if (!clean.length) return;
  await db
    .update(catalogItems)
    .set({ usageCount: sql`usage_count + 1`, updatedAt: new Date() })
    .where(inArray(catalogItems.id, clean));
}

/** Normalize the recall-pool rows across drivers (neon-http vs pglite execute())
 *  into LocalCatalogRow — the shape rankCandidates() consumes. usage_count is
 *  carried through for the re-rank; rankCandidates() strips it from the returned
 *  CatalogSearchResult, so the public result shape is unchanged. */
function normalizeRows(res: unknown): LocalCatalogRow[] {
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? [];
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    brand: (r.brand as string | null) ?? null,
    name: String(r.name),
    variant: (r.variant as string | null) ?? null,
    weightMg: Number(r.weight_mg),
    weightSource: String(r.weight_source),
    verified: Boolean(r.verified),
    usageCount: Number(r.usage_count),
    searchTerms: (r.search_terms as string | null) ?? null,
    commonName: (r.common_name as string | null) ?? null,
    categoryHint: (r.category_hint as string | null) ?? null,
    // null-guarded: Number(null) is 0, and 0 would read as a claimed calorie count
    kcal: r.kcal == null ? null : Number(r.kcal),
  }));
}

// ===========================================================================
// Trust-tiered wiki corrections (Phase 3) — "fix a wrong weight for everyone".
// (A) personal weight overrides live in the user's list and never come here.
// (B) a "fix for everyone" lands here: uncited/community values are wiki-open
// (apply instantly); a verified value only auto-applies with a citation from a
// trusted manufacturer/retailer domain — otherwise it's recorded as `proposed`.
// Every change is logged to catalog_edits so it's auditable + one-click revertible.
// ===========================================================================

// Manufacturer + retailer domains whose citation lets a correction to a *verified*
// weight auto-promote. Conservative + extensible; everything else stays proposed
// (this is what closes the weight-poisoning hole — see the hardening notes).
// Never a review site: the catalog audit refuses one as the source of a maker's weight
// (REVIEW_DOMAINS, scripts/catalogChecks.ts), and an applied fix re-anchors the row's
// source_url to what it cites. Two were listed here as retailers until 2026-11-25;
// tests/catalog.test.ts holds every domain here to the audit's rule. Exported for that.
export const TRUSTED_DOMAINS = new Set([
  // retailers
  "rei.com", "backcountry.com", "moosejaw.com", "garagegrowngear.com", "enwild.com",
  // mainstream brands
  "thermarest.com", "bigagnes.com", "nemoequipment.com", "msrgear.com", "osprey.com",
  "ospreyeurope.com", "patagonia.com", "arcteryx.com", "montbell.com", "montbell.us",
  "seatosummit.com", "exped.com", "gregorypacks.com", "marmot.com", "rab.equipment",
  // cottage / UL brands
  "zpacks.com", "durstongear.com", "gossamergear.com", "hyperlitemountaingear.com",
  "ula-equipment.com", "enlightenedequipment.com", "katabaticgear.com", "tarptent.com",
  "sixmoondesigns.com", "mountainlaureldesigns.com", "borahgear.com", "nunatakusa.com",
  "westernmountaineering.com", "featheredfriends.com", "timmermade.com", "bonfus.com",
  "palantepacks.com", "swdbackpacks.com", "litesmith.com",
]);

/** True only for http(s) URLs — keeps non-fetchable schemes (javascript:, data:)
 * out of stored citations, which get_catalog_edits hands on as links. */
export function isHttpUrl(url: string | undefined | null): boolean {
  return safeUrl(url) !== null;
}

/** True if `url` cites a trusted manufacturer/retailer domain (host or subdomain).
 *  Scheme-guarded by safeUrl first: javascript://zpacks.com/… parses a trusted hostname. */
export function isTrustedSource(url: string | undefined | null): boolean {
  const u = safeUrl(url);
  if (!u) return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const d of TRUSTED_DOMAINS) if (host === d || host.endsWith(`.${d}`)) return true;
  return false;
}


type CorrectionStatus = "applied" | "proposed" | "noop" | "rejected" | "notfound";
interface CorrectionOutcome {
  status: CorrectionStatus;
  weightMg?: number; // the catalog's current weight after the call
  itemName?: string;
}

/** Submit a "fix for everyone" correction; applies or proposes per the trust tier. */
export async function proposeCorrection(
  db: Db,
  input: { catalogItemId: number; newWeightMg: number; sourceUrl?: string; reason?: string },
): Promise<CorrectionOutcome> {
  const id = Number(input.catalogItemId);
  if (!isCatalogId(id)) return { status: "rejected" };
  const newW = Math.round(input.newWeightMg);
  // 100 kg per-item ceiling — the SAME cap the list reducer clamps to (shared/ops)
  if (!Number.isFinite(newW) || newW <= 0 || newW > UNIT_WEIGHT_MAX_MG) return { status: "rejected" };

  const rows = await db.select().from(catalogItems).where(eq(catalogItems.id, id)).limit(1);
  const item = rows[0];
  if (!item) return { status: "notfound" };
  const itemName = itemDisplayName(item.brand, item.name, item.variant);
  const oldW = Number(item.weightMg);
  if (newW === oldW) return { status: "noop", weightMg: oldW, itemName };

  // Drop non-http(s) schemes before the value is stored or rendered as a link
  // (javascript:/data: citations are an XSS vector wherever one is shown as a link, and a
  // `javascript://trusted-domain/` URL would otherwise pass isTrustedSource).
  const safeSource = isHttpUrl(input.sourceUrl) ? input.sourceUrl!.slice(0, MAX_URL_LEN) : undefined;
  const cited = isTrustedSource(safeSource);
  // uncited/community values are wiki-open; a verified value needs a trusted citation.
  // An admin's in-app verification never moves on its own: applied here, the weight would
  // leave its quote and weight_source behind, describing a figure the row no longer holds.
  const applies = item.verifiedBy == null && (!item.verified || cited);
  const status: "applied" | "proposed" = applies ? "applied" : "proposed";

  const edit = {
    catalogItemId: id,
    oldWeightMg: oldW,
    newWeightMg: newW,
    sourceUrl: safeSource ?? null,
    reason: input.reason?.slice(0, 500) ?? null,
    status,
  };
  // a fix that waits moves nothing: its line in the history is the only write
  if (!applies) {
    await db.insert(catalogEdits).values(edit);
    return { status, weightMg: oldW, itemName };
  }
  // The history and the row are written in ONE statement (the edit as a data-modifying
  // CTE, which Postgres runs whether or not the update reads it), as a verification's are
  // (catalogVerify.ts): written apart, a weight write that failed left an "applied" edit
  // for a change that never happened, and its undo would restore a weight the row never left.
  const logged = db.$with("logged").as(db.insert(catalogEdits).values(edit).returning({ id: catalogEdits.id }));
  await db
    .with(logged)
    .update(catalogItems)
    .set({
      weightMg: newW,
      updatedAt: new Date(),
      // a cited fix also (re)anchors the citation
      ...(cited && safeSource ? { sourceUrl: safeSource } : {}),
    })
    .where(eq(catalogItems.id, id));
  return { status, weightMg: newW, itemName };
}


/** Recent catalog edits (newest first), all of them or one row's: the admin patrol feed
 *  (get_catalog_edits) that names the ids revert_catalog_edit takes. */
export async function recentChanges(db: Db, limit: number, catalogItemId?: number): Promise<RecentChange[]> {
  const rows = await db
    .select({
      id: catalogEdits.id,
      catalogItemId: catalogEdits.catalogItemId,
      brand: catalogItems.brand,
      name: catalogItems.name,
      variant: catalogItems.variant,
      oldWeightMg: catalogEdits.oldWeightMg,
      newWeightMg: catalogEdits.newWeightMg,
      status: catalogEdits.status,
      verification: sql<boolean>`${catalogEdits.undo} is not null`,
      sourceUrl: catalogEdits.sourceUrl,
      reason: catalogEdits.reason,
      createdAt: catalogEdits.createdAt,
    })
    .from(catalogEdits)
    .leftJoin(catalogItems, eq(catalogEdits.catalogItemId, catalogItems.id))
    .where(catalogItemId == null ? undefined : eq(catalogEdits.catalogItemId, catalogItemId))
    // Timestamps are commonly equal for back-to-back edits (including on
    // PGlite), so the serial id is the deterministic second half of "newest".
    // Without it get_catalog_edits can hand the stale-revert guard the newer edit
    // as though it were the older one.
    .orderBy(desc(catalogEdits.createdAt), desc(catalogEdits.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    catalogItemId: Number(r.catalogItemId),
    // the left join leaves brand/name/variant null for an edit whose item is gone
    itemName: itemDisplayName(r.brand, r.name ?? "", r.variant) || "(removed item)",
    oldWeightMg: Number(r.oldWeightMg),
    newWeightMg: Number(r.newWeightMg),
    status: r.status,
    verification: Boolean(r.verification),
    sourceUrl: r.sourceUrl ?? null,
    reason: r.reason ?? null,
    createdAt: toIso(r.createdAt),
  }));
}
