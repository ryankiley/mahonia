// Catalog fuzzy-search ranking — the SINGLE source of truth shared by the server
// (the PGlite fallback path) and the client (offline search against a cached
// catalog snapshot). Keeping the trigram scoring + ranking here means offline
// results rank identically to production. Pure + framework-agnostic (unit-tested).

import { itemDisplayName } from "./weights";

/** The shared text fold: NFD → strip diacritics → lowercase → non-alphanumerics
 *  collapse to single spaces → trim. Diacritics fold to their base letter (ä→a, ū→u)
 *  BEFORE the a–z0–9 strip, so an accented brand ("Fjällräven") folds identically to
 *  its plain spelling ("Fjallraven") and each finds the other. Without the fold the
 *  accent bytes drop to spaces, fragmenting the word. The Neon path mirrors this with
 *  unaccent() (see server/utils/catalog.ts). trigrams() and the tier/prefix helpers
 *  below all fold through this ONE function so they can never drift apart. */
export function foldForSearch(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** pg_trgm-style trigrams over the folded string, each word padded (2 leading + 1
 *  trailing, like pg_trgm). Output is byte-identical to the prior inlined fold —
 *  guarded by the exact-set assertions in tests/catalogSearch.test.ts. */
export function trigrams(input: string): Set<string> {
  const cleaned = foldForSearch(input);
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

/** Base trigram score at/above which a fuzzy match counts as "strong" (Tier 1) in
 *  the re-ranker. Deliberately a SEPARATE constant from candidates.ts's
 *  DEDUP_THRESHOLD (also 0.6 today) — they gate different things and must be free
 *  to move independently. */
export const STRONG_THRESHOLD = 0.6;

/** Max autocomplete results — one constant shared by the server endpoint and the
 *  offline ranker so the two can never return different counts. */
export const SEARCH_LIMIT = 12;

/** Stage-1 recall pool size for the Neon path: fetch this many most-similar rows,
 *  then re-rank them in JS with rankCandidates() (the SAME ranking the offline path
 *  runs over the whole cached table). Comfortably above SEARCH_LIMIT so the final
 *  top-N is never starved — on the small, bounded catalog a real query clears the
 *  0.3 gate on far fewer than this. */
export const RANK_POOL = 100;

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
  // Extra searchable words (category noun + locale/synonym aliases) derived at
  // seed time — see shared/searchTerms.ts. Folded into the trigram target so
  // "tent" finds a "Copper Spur" and "rucksack" finds a "backpack".
  searchTerms?: string | null;
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
  // Carried through so the offline cache ranks identically to online (it matches
  // on this too). Not shown in the UI.
  searchTerms?: string | null;
}

/**
 * True when folded `query` exactly equals, whole-string-prefixes, or
 * word-boundary-prefixes folded `target` — the "I typed the start of the name"
 * case autocomplete must reward. Autocomplete token semantics: every query token
 * but the last must EQUAL consecutive target tokens; the last (the word still being
 * typed) may be a PREFIX. Multi-word aware, and the single window loop subsumes all
 * three cases (exact/whole-prefix = a match anchored at i=0; word-boundary-prefix =
 * a match at any later token boundary). Examples:
 *   "duplex" vs "Zpacks Duplex"        → last-token prefix at i=1        → true
 *   "x mid 2" vs "Durston X-Mid 2 Pro" → tokens align at i=1            → true
 *   "plex"  vs "Zpacks Duplex"         → mid-word substring, no boundary → false
 */
export function isExactOrPrefixMatch(query: string, target: string): boolean {
  const q = foldForSearch(query);
  if (!q) return false;
  const qt = q.split(/\s+/);
  const tt = foldForSearch(target).split(/\s+/);
  const last = qt.length - 1;
  for (let i = 0; i + qt.length <= tt.length; i++) {
    let ok = true;
    for (let k = 0; k < last; k++)
      if (tt[i + k] !== qt[k]) {
        ok = false;
        break;
      }
    if (ok && tt[i + last]!.startsWith(qt[last]!)) return true;
  }
  return false;
}

/**
 * Match-quality tier for ORDERING ONLY (0 = best). `brandName` is the exact/prefix
 * target (brand + name, no search_terms — a category noun shouldn't count as typing
 * the name). `score` is the already-computed base trigramScore against the FULL
 * target (brand + name + search_terms), reused here so Tier 1 still rewards the
 * "tent"→Copper Spur / "rucksack"→pack matches that live in search_terms. This is a
 * SEPARATE signal — it never calls into or changes trigramScore.
 */
export function matchTier(query: string, brandName: string, score: number): 0 | 1 | 2 {
  if (isExactOrPrefixMatch(query, brandName)) return 0; // exact / prefix / word-boundary-prefix
  if (score >= STRONG_THRESHOLD) return 1; // strong fuzzy match
  return 2; // cleared the SIM_THRESHOLD gate but weak
}

/**
 * The single source of truth for autocomplete ordering, applied identically to the
 * Neon candidate pool and the PGlite/offline table (its whole-table rows ARE the
 * pool). Two-stage: the caller's SQL/scan does coarse recall; this does the fine
 * ranking. Gate at `SIM_THRESHOLD`, then order by a relevance-tier cascade —
 *   tier ASC → verified DESC → usage_count DESC → base score DESC → id ASC
 * — so a clearly-better textual match (exact/prefix) can outrank a verified-but-
 * weaker one ("best match can win"), while among comparable matches verified then
 * usage still decide. The trailing `id ASC` is a deterministic tiebreak: without it
 * equal-scoring rows could swap between keystrokes. Capped at `limit`.
 */
export function rankCandidates(
  rows: LocalCatalogRow[],
  rawQuery: string,
  limit = SEARCH_LIMIT,
): CatalogSearchResult[] {
  const q = (rawQuery ?? "").trim();
  if (q.length < 2) return []; // 1 char is too noisy for trigram autocomplete
  return rows
    .map((r) => {
      const brandName = itemDisplayName(r.brand, r.name);
      // Score against name AND the derived search terms, mirroring the Neon target
      // (coalesce(brand,'') || ' ' || name || ' ' || coalesce(search_terms,'')).
      const score = trigramScore(q, `${brandName} ${r.searchTerms ?? ""}`);
      return { row: r, score, tier: matchTier(q, brandName, score) };
    })
    .filter((r) => r.score >= SIM_THRESHOLD)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(b.row.verified) - Number(a.row.verified) ||
        b.row.usageCount - a.row.usageCount ||
        b.score - a.score ||
        a.row.id - b.row.id,
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
      searchTerms: row.searchTerms ?? null,
    }));
}

/**
 * Offline / PGlite entry point: rank the entire (bounded) active catalog in JS with
 * the shared ranker. Kept as a named export for existing importers (the offline
 * cache + the server's PGlite branch); delegates to rankCandidates so ordering lives
 * in exactly one place.
 */
export function searchCatalogLocal(
  rows: LocalCatalogRow[],
  rawQuery: string,
  limit = SEARCH_LIMIT,
): CatalogSearchResult[] {
  return rankCandidates(rows, rawQuery, limit);
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
