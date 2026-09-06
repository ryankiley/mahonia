// Catalog fuzzy-search ranking — the SINGLE source of truth shared by the server
// (the PGlite fallback path) and the client (offline search against a cached
// catalog snapshot). Keeping the trigram scoring + ranking here means offline
// results rank identically to production. Pure + framework-agnostic (unit-tested).

import { itemDisplayName } from "./weights";
import { foldForSearch } from "./searchText";

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

/** The autocomplete result shape returned to the client (no usageCount). */
export interface CatalogSearchResult {
  id: number;
  brand: string | null;
  name: string;
  variant: string | null;
  weightMg: number;
  weightSource: string;
  verified: boolean;
  // Extra searchable words (category noun + locale/synonym aliases) derived at
  // seed time — see scripts/searchTerms.ts. Folded into the trigram target so
  // "tent" finds a "Copper Spur" and "rucksack" finds a "backpack". Carried through
  // so the offline cache ranks identically to online. Not shown in the UI.
  searchTerms?: string | null;
  // The catalog's default common name → pre-fills the picked item's commonName.
  // Not used for ranking.
  commonName?: string | null;
  // The row's catalog category ("shelter" … "consumable"). Carried so a pick can
  // pre-classify the food/fuel rows as consumable — the catalog already knows a
  // Clif bar isn't base weight, and without this the row lands on the folder
  // default and quietly counts toward base. Not used for ranking.
  categoryHint?: string | null;
  // Cited per-unit food energy (the calorie twin of weightMg) — food rows only,
  // null elsewhere. Carried so a pick pre-fills the row's kcal the way weightMg
  // pre-fills its weight; the rows that have it arrive classified consumable via
  // categoryHint, which is the only place a row's kcal is reachable or counted.
  // Not used for ranking.
  kcal?: number | null;
}

/** A catalog row as needed for local ranking: the result shape plus the usage count
 *  the re-rank consumes and rankCandidates() strips back out. Declared off the result
 *  type so the two can't drift — every searchable field is described once, above. */
export interface LocalCatalogRow extends CatalogSearchResult {
  usageCount: number;
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

/** Fold + split once, for the token-level helpers below. */
function tokens(s: string | null | undefined): string[] {
  const folded = foldForSearch(s ?? "");
  return folded ? folded.split(/\s+/) : [];
}

/**
 * Whether `query` names the row's KIND of gear: its tokens are a leading run of the
 * row's common-name tokens, the last one still being typed ("sleeping b" → "Sleeping
 * bag", and "Sleeping bag liner"). 0 = no; 1 = a leading prefix of a longer type;
 * 2 = the whole type. The 1/2 split breaks the tie the word-match ranker couldn't:
 * "sleeping bag" is the whole of "Sleeping bag" and only a prefix of "Sleeping bag
 * liner", so bags outrank liners; "tent" is the whole of "Tent" and nothing of
 * "Groundsheet", so a ground cloth with "Tent" in its NAME no longer beats every tent
 * whose name never says the word. common_name is the curated type; search_terms is
 * derived from the name's words and can't be trusted for this (that ground cloth's
 * search_terms ARE "tent").
 */
export function typeMatch(query: string, commonName: string | null | undefined): 0 | 1 | 2 {
  const qt = tokens(query);
  const tt = tokens(commonName);
  if (!qt.length || !tt.length || qt.length > tt.length) return 0;
  for (let k = 0; k < qt.length - 1; k++) if (qt[k] !== tt[k]) return 0;
  if (!tt[qt.length - 1]!.startsWith(qt[qt.length - 1]!)) return 0;
  return qt.length === tt.length ? 2 : 1;
}

/**
 * Whether some query token (3+ chars, so "ul" or "2" can't anchor a match) starts a
 * target token. The word-boundary evidence a "strong" fuzzy match has to show:
 * trigram coverage alone let "battery" clear 0.6 against "Klättermusen … dry bag" on
 * the strength of "att", "tte", "ter" and " ba".
 */
export function hasTokenHit(query: string, target: string): boolean {
  const tt = tokens(target);
  return tokens(query).some((q) => q.length >= 3 && tt.some((t) => t.startsWith(q)));
}

/**
 * Whether the query is a contiguous run of the row's search terms — the derived
 * category noun and its synonyms ("puffy" in "down jacket puffy"), last token still
 * being typed. Decides only that a query names a KIND of gear (see the diversity
 * cap in rankCandidates); it never ranks a row.
 */
export function isSearchTermRun(query: string, searchTerms: string | null | undefined): boolean {
  const qt = tokens(query);
  const tt = tokens(searchTerms);
  if (!qt.length || qt.length > tt.length) return false;
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

export type MatchTier = 0 | 1 | 2 | 3;

/**
 * Match-quality tier for ORDERING ONLY (0 = best).
 *   0  the query names the row's kind of gear (typeMatch on common_name)
 *   1  exact / prefix / word-boundary-prefix on brand + name — "I typed the name"
 *   2  strong fuzzy: score ≥ STRONG_THRESHOLD AND a word-boundary token hit
 *   3  cleared the SIM_THRESHOLD gate but weak (a typo's recall, kept only when
 *      nothing better matched — see the junk filter in rankCandidates)
 * `brandName` is the prefix target (brand + name, no search_terms — a category noun
 * shouldn't count as typing the name). `score` is the base trigramScore against the
 * FULL target (brand + name + search_terms), reused so tier 2 still rewards the
 * "rucksack"→pack matches that live in search_terms.
 */
export function matchTier(
  query: string,
  brandName: string,
  score: number,
  commonName?: string | null,
  searchTerms?: string | null,
): MatchTier {
  if (typeMatch(query, commonName)) return 0;
  if (isExactOrPrefixMatch(query, brandName)) return 1;
  if (score >= STRONG_THRESHOLD && hasTokenHit(query, `${brandName} ${searchTerms ?? ""}`)) return 2;
  return 3;
}

/** Per-product and per-brand caps for a query that names a kind of gear, so one pad
 *  in five sizes or one brand's eight socks can't take the whole menu: twelve slots
 *  become six brands, two rows each (a Men's/Women's pair survives the product cap). Sizes come
 *  straight back the moment the query names the product ("tensor"), because the cap
 *  applies to generic queries only. An unbranded row escapes the brand cap: "" is
 *  not a brand, and lumping every generic item together would hide them. */
const FAMILY_CAP = 2;
const BRAND_CAP = 2;

function diversify<T extends { row: LocalCatalogRow }>(sorted: T[], limit: number): T[] {
  const perFamily = new Map<string, number>();
  const perBrand = new Map<string, number>();
  const picked: T[] = [];
  const overflow: T[] = [];
  for (const r of sorted) {
    const brand = foldForSearch(r.row.brand ?? "");
    const family = `${brand}|${foldForSearch(r.row.name)}`;
    const famN = perFamily.get(family) ?? 0;
    const brandN = perBrand.get(brand) ?? 0;
    if (famN >= FAMILY_CAP || (brand && brandN >= BRAND_CAP)) {
      overflow.push(r);
      continue;
    }
    perFamily.set(family, famN + 1);
    perBrand.set(brand, brandN + 1);
    picked.push(r);
  }
  // the caps spread the menu; they never shorten it — when the spread runs out, the
  // capped rows fill the remaining slots in their original order
  return picked.length >= limit ? picked.slice(0, limit) : [...picked, ...overflow].slice(0, limit);
}

/**
 * The single source of truth for autocomplete ordering, applied identically to the
 * Neon candidate pool and the PGlite/offline table (its whole-table rows ARE the
 * pool). Two-stage: the caller's SQL/scan does coarse recall; this does the fine
 * ranking. Gate at `SIM_THRESHOLD`, drop the weak tier when anything better
 * matched, then order by a relevance cascade —
 *   tier ASC → whole-type before type-prefix → verified DESC → usage_count DESC →
 *   base score DESC → id ASC
 * — so a clearly-better match can outrank a verified-but-weaker one ("best match can
 * win"), while among comparable matches verified then usage still decide. The
 * trailing `id ASC` is a deterministic tiebreak: without it equal-scoring rows could
 * swap between keystrokes. When the query names a KIND of gear rather than a product
 * or brand, the diversity caps above spread the result across products and brands.
 * Capped at `limit`.
 */
export function rankCandidates(
  rows: LocalCatalogRow[],
  rawQuery: string,
  limit = SEARCH_LIMIT,
): CatalogSearchResult[] {
  const q = (rawQuery ?? "").trim();
  if (q.length < 2) return []; // 1 char is too noisy for trigram autocomplete
  const scored = rows
    .map((r) => {
      const brandName = itemDisplayName(r.brand, r.name);
      // Score against name AND the derived search terms, mirroring the Neon target
      // (coalesce(brand,'') || ' ' || name || ' ' || coalesce(search_terms,'')).
      const score = trigramScore(q, `${brandName} ${r.searchTerms ?? ""}`);
      return {
        row: r,
        score,
        type: typeMatch(q, r.commonName),
        tier: matchTier(q, brandName, score, r.commonName, r.searchTerms),
      };
    })
    .filter((r) => r.score >= SIM_THRESHOLD);
  // Junk filter: a weak trigram match is a typo's safety net, not a peer of a real
  // hit. With anything better in the pool it only pads the menu ("copper spur" once
  // ended in a compass and a spoon cover). With nothing better it IS the answer for
  // a single word (a typo of one word looks like this) — but a multi-word query that
  // starts no word of any row is a custom name ("my car keys"), and twelve
  // look-alikes under it are noise: the menu stays shut and the typed text stands.
  const anyReal = scored.some((r) => r.tier < 3);
  const kept = anyReal ? scored.filter((r) => r.tier < 3) : tokens(q).length > 1 ? [] : scored;
  kept.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.type - a.type ||
      Number(b.row.verified) - Number(a.row.verified) ||
      b.row.usageCount - a.row.usageCount ||
      b.score - a.score ||
      a.row.id - b.row.id,
  );
  // a query that names a kind of gear — a common name, or a derived noun/synonym —
  // gets the spread; a product or brand name gets every size it has
  const generic = scored.some((r) => r.type > 0 || isSearchTermRun(q, r.row.searchTerms));
  const ordered = generic ? diversify(kept, limit) : kept.slice(0, limit);
  return ordered.map(({ row }) => toCatalogResult(row));
}

/** A loaded/ranked row in the autocomplete's result shape: usageCount dropped, the
 *  weight a number (bigint columns arrive as strings on Neon), nullable fields null.
 *  The one place the shape is spelled out — the ranker and the import matcher's
 *  whole-table read (server/utils/catalog.ts) both go through it. */
export function toCatalogResult(row: LocalCatalogRow): CatalogSearchResult {
  return {
    id: row.id,
    brand: row.brand,
    name: row.name,
    variant: row.variant,
    weightMg: Number(row.weightMg),
    weightSource: row.weightSource,
    verified: Boolean(row.verified),
    searchTerms: row.searchTerms ?? null,
    commonName: row.commonName ?? null,
    categoryHint: row.categoryHint ?? null,
    kcal: row.kcal ?? null,
  };
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
