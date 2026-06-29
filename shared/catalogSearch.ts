// Catalog fuzzy-search ranking — the SINGLE source of truth shared by the server
// (the PGlite fallback path) and the client (offline search against a cached
// catalog snapshot). Keeping the trigram scoring + ranking here means offline
// results rank identically to production. Pure + framework-agnostic (unit-tested).

import { itemDisplayName } from "./weights";

/** pg_trgm-style trigrams: lowercase, non-alphanumerics→space, each word padded. */
export function trigrams(input: string): Set<string> {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const out = new Set<string>();
  if (!cleaned) return out;
  for (const word of cleaned.split(/\s+/)) {
    const padded = `  ${word} `; // 2 leading + 1 trailing, like pg_trgm
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * How well `query` is covered by `target` (≈ pg_trgm word_similarity intent):
 * |T(query) ∩ T(target)| / |T(query)|. Rewards a short fragment/typo that's a
 * substring-ish of a longer name ("duplx" → "zpacks duplex" ≈ 0.67).
 */
export function trigramScore(query: string, target: string): number {
  const q = trigrams(query);
  if (q.size === 0) return 0;
  const t = trigrams(target);
  let hits = 0;
  for (const g of q) if (t.has(g)) hits++;
  return hits / q.size;
}

export const SIM_THRESHOLD = 0.3; // matches pg_trgm's default similarity threshold

/** A catalog row as needed for local ranking (a subset of the DB row). */
export interface LocalCatalogRow {
  id: number;
  brand: string | null;
  name: string;
  variant: string | null;
  weightMg: number;
  weightSource: string;
  verified: boolean;
  usageCount: number;
}

/** The autocomplete result shape returned to the client (no usageCount). */
export interface CatalogSearchResult {
  id: number;
  brand: string | null;
  name: string;
  variant: string | null;
  weightMg: number;
  weightSource: string;
  verified: boolean;
}

/**
 * Rank `rows` against `query` exactly as the server's PGlite fallback does:
 * trigram coverage ≥ threshold, ordered `verified DESC, usage_count DESC,
 * similarity DESC`, capped at `limit`. Used by the server (PGlite) and by the
 * client's offline catalog search so the two never diverge.
 */
export function searchCatalogLocal(
  rows: LocalCatalogRow[],
  rawQuery: string,
  limit = 8,
): CatalogSearchResult[] {
  const q = (rawQuery ?? "").trim();
  if (q.length < 2) return []; // 1 char is too noisy for trigram autocomplete
  return rows
    .map((r) => ({ row: r, score: trigramScore(q, itemDisplayName(r.brand, r.name)) }))
    .filter((r) => r.score >= SIM_THRESHOLD)
    .sort(
      (a, b) =>
        Number(b.row.verified) - Number(a.row.verified) ||
        b.row.usageCount - a.row.usageCount ||
        b.score - a.score,
    )
    .slice(0, limit)
    .map(({ row }) => ({
      id: row.id,
      brand: row.brand,
      name: row.name,
      variant: row.variant,
      weightMg: Number(row.weightMg),
      weightSource: row.weightSource,
      verified: Boolean(row.verified),
    }));
}

/**
 * Fold freshly-seen catalog rows into the on-device cache: dedup by id (the
 * incoming/fresher copy wins), most-recently-seen first, capped to `cap`. Pure so
 * it's unit-testable; the client (useCatalogCache) builds its offline index by
 * running each online search's results through this — no bulk-dump endpoint, so it
 * adds zero new scraping surface beyond the rate-limited search.
 */
export function mergeCatalogRows(
  existing: LocalCatalogRow[],
  incoming: LocalCatalogRow[],
  cap = 2000,
): LocalCatalogRow[] {
  const seen = new Set<number>();
  const out: LocalCatalogRow[] = [];
  for (const row of [...incoming, ...existing]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= cap) break;
  }
  return out;
}
