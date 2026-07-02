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

import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { catalogEdits, catalogItems } from "../db/schema";
import { itemDisplayName } from "../../shared/weights";
import { UNIT_WEIGHT_MAX_MG } from "../../shared/ops";
import { memoizedEnsure } from "./memoize";
import {
  SIM_THRESHOLD,
  searchCatalogLocal,
  type CatalogSearchResult,
  type LocalCatalogRow,
} from "../../shared/catalogSearch";

// trigrams/trigramScore live in shared/catalogSearch (single source of truth for
// the offline client + this server fallback) — re-exported so existing importers
// (candidates.ts, tests) keep their import path.
export { trigrams, trigramScore } from "../../shared/catalogSearch";

const isNeon = () => Boolean(process.env.DATABASE_URL);

// Safe on BOTH PGlite and Neon. Single source of truth; also spread into db.ts's
// local idempotent DDL. The pg_trgm GIN index is created separately (Neon only).
export const CATALOG_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS catalog_items (
    id serial PRIMARY KEY,
    brand text,
    name text NOT NULL,
    variant text,
    description text,
    category_hint text,
    weight_mg bigint NOT NULL,
    weight_source text NOT NULL CHECK (weight_source IN ('manufacturer','measured','community','imported')),
    source_url text,
    product_url text,
    image_url text,
    msrp_cents integer,
    currency text,
    verified boolean NOT NULL DEFAULT false,
    usage_count integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','removed')),
    merged_into_id integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
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
    confirmations integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_edits_item ON catalog_edits (catalog_item_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_catalog_edits_recent ON catalog_edits (created_at DESC)`,
];

/** Idempotently create the catalog table + indexes (memoized per process). */
export const ensureCatalogSchema = memoizedEnsure(async (db: unknown) => {
  const d = db as { execute: (q: unknown) => Promise<unknown> };
  for (const stmt of CATALOG_DDL) await d.execute(sql.raw(stmt));
  if (isNeon()) {
    // Neon ships pg_trgm — create the extension + GIN trigram index that
    // power fuzzy autocomplete. (No-op'd locally; see file header.)
    await d.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS pg_trgm`));
    await d.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS idx_catalog_trgm ON catalog_items USING gin ((coalesce(brand,'') || ' ' || name) gin_trgm_ops)`,
      ),
    );
  }
});

function normalizeQuery(q: unknown): string {
  return typeof q === "string" ? q.trim() : "";
}

/**
 * Fuzzy autocomplete. Returns up to `limit` results ordered
 * `verified DESC, usage_count DESC, similarity DESC`, gated to relevant matches.
 * pg_trgm on Neon; JS trigram ranking on PGlite (see file header).
 */
export async function searchCatalog(
  db: unknown,
  rawQuery: unknown,
  limit = 8,
): Promise<CatalogSearchResult[]> {
  const q = normalizeQuery(rawQuery);
  if (q.length < 2) return []; // 1 char is too noisy for trigram autocomplete

  if (isNeon()) {
    const d = db as { execute: (query: unknown) => Promise<unknown> };
    // word_similarity matches a short query against the best extent of a longer
    // name — the right metric for autocomplete fragments. We DON'T use the `<%`
    // operator: its threshold is the GUC pg_trgm.word_similarity_threshold, which
    // defaults to 0.6 — ~2x stricter than the local JS fallback's SIM_THRESHOLD
    // (0.3), so typo'd/partial queries ("kawa 55", "palante") that match locally
    // returned nothing in prod. Filtering on the function with our own threshold
    // makes prod recall match local. The catalog is small + bounded, so the seq
    // scan (we forgo the gin_trgm_ops index this way) is cheap. Bound params are
    // injection-safe.
    const res = await d.execute(sql`
      select id, brand, name, variant, weight_mg, weight_source, verified
      from catalog_items
      where status = 'active'
        and word_similarity(${q}, coalesce(brand,'') || ' ' || name) >= ${SIM_THRESHOLD}
      order by verified desc,
               usage_count desc,
               word_similarity(${q}, coalesce(brand,'') || ' ' || name) desc
      limit ${limit}
    `);
    return normalizeRows(res);
  }

  // PGlite: load the bounded active catalog and rank in JS — the SAME ranking the
  // offline client uses (searchCatalogLocal is the shared source of truth).
  const d = db as unknown as {
    select: () => {
      from: (t: typeof catalogItems) => {
        where: (w: unknown) => Promise<Array<Record<string, unknown>>>;
      };
    };
  };
  const rows = await d.select().from(catalogItems).where(eq(catalogItems.status, "active"));
  return searchCatalogLocal(rows as unknown as LocalCatalogRow[], q, limit);
}

/**
 * Increment usage_count for catalog rows that were just added to a list. This is
 * what makes autocomplete self-improve: the gear people actually carry floats to
 * the top of the ranking. Best-effort + bounded; works on PGlite + Neon.
 */
export async function bumpUsage(db: unknown, ids: number[]): Promise<void> {
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
  if (!clean.length) return;
  const d = db as {
    update: (t: typeof catalogItems) => {
      set: (v: unknown) => { where: (w: unknown) => Promise<unknown> };
    };
  };
  await d
    .update(catalogItems)
    .set({ usageCount: sql`usage_count + 1`, updatedAt: new Date() })
    .where(inArray(catalogItems.id, clean));
}

/** Normalize the row shape across drivers (neon-http vs pglite execute()). */
function normalizeRows(res: unknown): CatalogSearchResult[] {
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? [];
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    brand: (r.brand as string | null) ?? null,
    name: String(r.name),
    variant: (r.variant as string | null) ?? null,
    weightMg: Number(r.weight_mg),
    weightSource: String(r.weight_source),
    verified: Boolean(r.verified),
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
const TRUSTED_DOMAINS = new Set([
  // retailers
  "rei.com", "backcountry.com", "moosejaw.com", "garagegrowngear.com", "enwild.com",
  "sectionhiker.com", "outdoorgearlab.com",
  // mainstream brands
  "thermarest.com", "bigagnes.com", "nemoequipment.com", "msrgear.com", "osprey.com",
  "ospreyeurope.com", "patagonia.com", "arcteryx.com", "montbell.com", "montbell.us",
  "seatosummit.com", "exped.com", "gregorypacks.com", "marmot.com", "rab.equipment",
  // cottage / UL brands
  "zpacks.com", "durstongear.com", "gossamergear.com", "hyperlitemountaingear.com",
  "ula-equipment.com", "enlightenedequipment.com", "katabaticgear.com", "tarptent.com",
  "sixmoondesigns.com", "mountainlaureldesigns.com", "borahgear.com", "nunatakusa.com",
  "westernmountaineering.com", "featheredfriends.com", "timmermade.com", "bonfus.com",
  "palantepacks.com", "swdbackpacks.com", "litesmith.com", "garagegrowngear.com",
]);

/** True only for http(s) URLs — keeps non-fetchable schemes (javascript:, data:)
 * out of stored citations, which are rendered as links in the changes feed. */
export function isHttpUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/** True if `url` cites a trusted manufacturer/retailer domain (host or subdomain). */
export function isTrustedSource(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    // scheme guard first: javascript://zpacks.com/… parses a trusted hostname
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const d of TRUSTED_DOMAINS) if (host === d || host.endsWith(`.${d}`)) return true;
    return false;
  } catch {
    return false;
  }
}


export type CorrectionStatus = "applied" | "proposed" | "noop" | "rejected" | "notfound";
export interface CorrectionOutcome {
  status: CorrectionStatus;
  weightMg?: number; // the catalog's current weight after the call
  itemName?: string;
}

/** Submit a "fix for everyone" correction; applies or proposes per the trust tier. */
export async function proposeCorrection(
  db: unknown,
  input: { catalogItemId: number; newWeightMg: number; sourceUrl?: string; reason?: string },
): Promise<CorrectionOutcome> {
  const d = db as {
    select: (...a: unknown[]) => any;
    insert: (t: unknown) => any;
    update: (t: unknown) => any;
  };
  const id = Number(input.catalogItemId);
  if (!Number.isInteger(id) || id <= 0) return { status: "rejected" };
  const newW = Math.round(input.newWeightMg);
  // 100 kg per-item ceiling — the SAME cap the list reducer clamps to (shared/ops)
  if (!Number.isFinite(newW) || newW <= 0 || newW > UNIT_WEIGHT_MAX_MG) return { status: "rejected" };

  const rows = await d.select().from(catalogItems).where(eq(catalogItems.id, id)).limit(1);
  const item = rows[0];
  if (!item) return { status: "notfound" };
  const itemName = itemDisplayName(item.brand, item.name, item.variant);
  const oldW = Number(item.weightMg);
  if (newW === oldW) return { status: "noop", weightMg: oldW, itemName };

  // Drop non-http(s) schemes before the value is stored or rendered as a link
  // (javascript:/data: citations are an XSS vector in the changes feed, and a
  // `javascript://trusted-domain/` URL would otherwise pass isTrustedSource).
  const safeSource = isHttpUrl(input.sourceUrl) ? input.sourceUrl!.slice(0, 2000) : undefined;
  const cited = isTrustedSource(safeSource);
  // uncited/community values are wiki-open; a verified value needs a trusted citation
  const applies = !item.verified || cited;
  const status: "applied" | "proposed" = applies ? "applied" : "proposed";

  await d.insert(catalogEdits).values({
    catalogItemId: id,
    oldWeightMg: oldW,
    newWeightMg: newW,
    sourceUrl: safeSource ?? null,
    reason: input.reason?.slice(0, 500) ?? null,
    status,
  });

  if (applies) {
    await d
      .update(catalogItems)
      .set({
        weightMg: newW,
        updatedAt: new Date(),
        // a cited fix also (re)anchors the citation
        ...(cited && safeSource ? { sourceUrl: safeSource } : {}),
      })
      .where(eq(catalogItems.id, id));
  }
  return { status, weightMg: applies ? newW : oldW, itemName };
}

export interface RecentChange {
  id: number;
  itemName: string;
  oldWeightMg: number;
  newWeightMg: number;
  status: string;
  sourceUrl: string | null;
  createdAt: string;
}

/** Recent catalog weight changes (newest first) — the patrol / transparency feed. */
export async function recentChanges(db: unknown, limit = 50): Promise<RecentChange[]> {
  const d = db as { select: (...a: unknown[]) => any };
  const rows = await d
    .select({
      id: catalogEdits.id,
      brand: catalogItems.brand,
      name: catalogItems.name,
      variant: catalogItems.variant,
      oldWeightMg: catalogEdits.oldWeightMg,
      newWeightMg: catalogEdits.newWeightMg,
      status: catalogEdits.status,
      sourceUrl: catalogEdits.sourceUrl,
      createdAt: catalogEdits.createdAt,
    })
    .from(catalogEdits)
    .leftJoin(catalogItems, eq(catalogEdits.catalogItemId, catalogItems.id))
    .orderBy(desc(catalogEdits.createdAt))
    .limit(Math.min(100, Math.max(1, limit)));
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    itemName:
      itemDisplayName(r.brand as string | null, String(r.name ?? ""), r.variant as string | null) ||
      "(removed item)",
    oldWeightMg: Number(r.oldWeightMg),
    newWeightMg: Number(r.newWeightMg),
    status: String(r.status),
    sourceUrl: (r.sourceUrl as string | null) ?? null,
    createdAt:
      r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt ?? ""),
  }));
}

/** One-click revert (admin): restore an applied edit's prior weight + mark it reverted. */
export async function revertEdit(db: unknown, editId: number): Promise<CorrectionOutcome> {
  const d = db as { select: (...a: unknown[]) => any; update: (t: unknown) => any };
  const id = Number(editId);
  if (!Number.isInteger(id) || id <= 0) return { status: "rejected" };
  const rows = await d.select().from(catalogEdits).where(eq(catalogEdits.id, id)).limit(1);
  const edit = rows[0];
  if (!edit) return { status: "notfound" };
  if (edit.status !== "applied") return { status: "rejected" }; // only applied edits moved a weight
  // only the MOST RECENT applied edit can be reverted — reverting an older one
  // would silently discard newer changes and desync the weight from the feed
  const newer = await d
    .select({ id: catalogEdits.id })
    .from(catalogEdits)
    .where(
      and(
        eq(catalogEdits.catalogItemId, Number(edit.catalogItemId)),
        eq(catalogEdits.status, "applied"),
        gt(catalogEdits.id, id),
      ),
    )
    .limit(1);
  if (newer.length) return { status: "rejected" };
  await d
    .update(catalogItems)
    .set({ weightMg: Number(edit.oldWeightMg), updatedAt: new Date() })
    .where(eq(catalogItems.id, Number(edit.catalogItemId)));
  await d.update(catalogEdits).set({ status: "reverted" }).where(eq(catalogEdits.id, id));
  return { status: "applied", weightMg: Number(edit.oldWeightMg) };
}
