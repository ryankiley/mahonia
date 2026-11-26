// Catalog fuzzy-search ranking — the SINGLE source of truth shared by the server
// (the PGlite fallback path) and the client (offline search against a cached
// catalog snapshot). Keeping the trigram scoring + ranking here means offline
// results rank identically to production. Pure + framework-agnostic (unit-tested).

import { itemDisplayName } from "./weights";
import { enoughToSearch, foldForSearch, hasIdeograph, hasKana } from "./searchText";

/** pg_trgm-style trigrams over the folded string, each word padded (2 leading + 1
 *  trailing, like pg_trgm). Output is byte-identical to the prior inlined fold —
 *  guarded by the exact-set assertions in tests/catalogSearch.test.ts. */
export function trigrams(input: string): Set<string> {
  const out = new Set<string>();
  for (const word of searchTokens(input)) {
    const padded = `  ${word} `; // 2 leading + 1 trailing, like pg_trgm
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * Fold + split: the words every helper here compares. Remembered per spelling, because
 * a search is the same few thousand row texts folded again on every keystroke and the
 * fold is most of what a ranking costs. Keyed on the text itself, so an edited row is
 * simply a new key; emptied when it fills.
 */
export function searchTokens(s: string | null | undefined): readonly string[] {
  if (!s) return NO_TOKENS;
  let words = folded.get(s);
  if (!words) {
    const text = foldForSearch(s);
    words = text ? text.split(/\s+/) : NO_TOKENS;
    if (folded.size >= FOLDED_MAX) folded.clear();
    folded.set(s, words);
  }
  return words;
}
const NO_TOKENS: readonly string[] = [];
const folded = new Map<string, readonly string[]>();
const FOLDED_MAX = 20_000;

/**
 * A query folded ONCE, for scoring against many rows. The fold is two Unicode
 * normalisations and five regex passes, and a ranker that took the query as a string
 * re-ran it for every row it looked at, several times over (the score, the type, the
 * tier, the junk filter): on the offline cache that is two thousand rows a keystroke.
 */
export interface SearchQuery {
  tokens: readonly string[];
  grams: readonly string[];
}
export function searchQuery(query: string): SearchQuery {
  return { tokens: searchTokens(query), grams: [...trigrams(query)] };
}

/**
 * How well the query is covered by a target's words (≈ pg_trgm word_similarity
 * intent): |T(query) ∩ T(target)| / |T(query)|. Rewards a short fragment/typo that's a
 * substring-ish of a longer name ("duplx" → "zpacks duplex" ≈ 0.67).
 *
 * The target's trigram set is never built. A trigram of a word is exactly a
 * three-character window of that word padded, so membership is `includes` on the
 * padded words laid end to end; the only windows that straddle two words are
 * letter-space-space and three spaces, which no query trigram is.
 */
export function coverage(query: SearchQuery, target: readonly string[]): number {
  if (!query.grams.length) return 0;
  let hay = "";
  for (const word of target) hay += `  ${word} `;
  let hits = 0;
  for (const g of query.grams) if (hay.includes(g)) hits++;
  return hits / query.grams.length;
}

/** `coverage` for one query against one target, both as typed. */
export function trigramScore(query: string, target: string): number {
  return coverage(searchQuery(query), searchTokens(target));
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
 * True when the query's words (`qt`, folded by searchTokens) exactly equal,
 * whole-string-prefix, or word-boundary-prefix the target's (`tt`) — the "I typed the
 * start of the name" case autocomplete must reward. Autocomplete token semantics: every
 * query token but the last must EQUAL consecutive target tokens; the last (the word
 * still being typed) may be a PREFIX. Multi-word aware, and the single window loop
 * (tokensRunIn) subsumes all three cases (exact/whole-prefix = a match anchored at i=0;
 * word-boundary-prefix = a match at any later token boundary). An empty query runs in
 * nothing. Examples:
 *   "duplex" vs "Zpacks Duplex"        → last-token prefix at i=1        → true
 *   "x mid 2" vs "Durston X-Mid 2 Pro" → tokens align at i=1            → true
 *   "plex"  vs "Zpacks Duplex"         → mid-word substring, no boundary → false
 *
 * Asked of a row's search terms — the derived category noun and its synonyms ("puffy"
 * in "down jacket puffy") — it decides only that a query names a KIND of gear (see the
 * diversity cap in rankCandidates); it never ranks a row.
 */
export function runsIn(qt: readonly string[], tt: readonly string[]): boolean {
  return qt.length > 0 && tokensRunIn(qt, tt);
}

/**
 * Whether the query's tokens sit over the target's from token `i`: every one but the
 * last must EQUAL its counterpart, the last (the word still being typed) may be a
 * PREFIX. The caller keeps `i + qt.length <= tt.length`, so every read is in range.
 */
function tokensMatchAt(qt: readonly string[], tt: readonly string[], i: number): boolean {
  const last = qt.length - 1;
  for (let k = 0; k < last; k++) if (tt[i + k] !== qt[k]) return false;
  return tt[i + last]!.startsWith(qt[last]!);
}

/** …at ANY token boundary of the target: the one window loop that the name match and
 *  the search-term run each used to carry a copy of. */
function tokensRunIn(qt: readonly string[], tt: readonly string[]): boolean {
  for (let i = 0; i + qt.length <= tt.length; i++) if (tokensMatchAt(qt, tt, i)) return true;
  return false;
}

/**
 * Whether the query (`qt`) names the row's KIND of gear: its tokens are a leading run of
 * the row's common-name tokens (`tt`), the last one still being typed ("sleeping b" → "Sleeping
 * bag", and "Sleeping bag liner"). 0 = no; 1 = a leading prefix of a longer type;
 * 2 = the whole type. The 1/2 split breaks the tie the word-match ranker couldn't:
 * "sleeping bag" is the whole of "Sleeping bag" and only a prefix of "Sleeping bag
 * liner", so bags outrank liners; "tent" is the whole of "Tent" and nothing of
 * "Groundsheet", so a ground cloth with "Tent" in its NAME no longer beats every tent
 * whose name never says the word. common_name is the curated type; search_terms is
 * derived from the name's words and can't be trusted for this (that ground cloth's
 * search_terms ARE "tent").
 */
export function typeOf(qt: readonly string[], tt: readonly string[]): 0 | 1 | 2 {
  if (!qt.length || !tt.length || qt.length > tt.length) return 0;
  if (!tokensMatchAt(qt, tt, 0)) return 0;
  return qt.length === tt.length ? 2 : 1;
}

/**
 * Whether some query token (3+ chars, so "ul" or "2" can't anchor a match — or any
 * ideographs or kana, since "帐篷" and "なべ" are whole words) starts a target token. The
 * word-boundary evidence a "strong" fuzzy match has to show: trigram coverage alone
 * let "battery" clear 0.6 against "Klättermusen … dry bag" on the strength of "att",
 * "tte", "ter" and " ba".
 */
export function tokenHit(qt: readonly string[], tt: readonly string[]): boolean {
  return qt.some((q) => (q.length >= 3 || hasIdeograph(q) || hasKana(q)) && tt.some((t) => t.startsWith(q)));
}

export type MatchTier = 0 | 1 | 2 | 3;

/**
 * Match-quality tier for ORDERING ONLY (0 = best).
 *   0  the query names the row's kind of gear (`type`: typeOf on common_name)
 *   1  exact / prefix / word-boundary-prefix on brand + name — "I typed the name"
 *   2  strong fuzzy: score ≥ STRONG_THRESHOLD AND a word-boundary token hit
 *   3  cleared the SIM_THRESHOLD gate but weak (a typo's recall, kept only when
 *      nothing better matched — see the junk filter in rankCandidates)
 * Every argument is words already folded. `name` is the prefix target (brand + name, no
 * search_terms — a category noun shouldn't count as typing the name). `score` is the
 * base trigram coverage against `all`, the FULL target (brand + name + search_terms),
 * reused so tier 2 still rewards the "rucksack"→pack matches that live in search_terms.
 */
export function tierOf(
  qt: readonly string[],
  type: 0 | 1 | 2,
  name: readonly string[],
  all: readonly string[],
  score: number,
): MatchTier {
  if (type) return 0;
  if (runsIn(qt, name)) return 1;
  if (score >= STRONG_THRESHOLD && tokenHit(qt, all)) return 2;
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
  if (!enoughToSearch(q)) return []; // 1 char is too noisy for trigrams, unless it is a word
  const query = searchQuery(q);
  const qt = query.tokens;
  const scored: { row: LocalCatalogRow; score: number; type: 0 | 1 | 2; tier: MatchTier; terms: readonly string[] }[] = [];
  for (const row of rows) {
    // Score against name AND the derived search terms, mirroring the Neon target
    // (coalesce(brand,'') || ' ' || name || ' ' || coalesce(search_terms,'')). Each is
    // folded once and reused by everything below; a row under the gate stops here.
    const name = searchTokens(itemDisplayName(row.brand, row.name));
    const terms = searchTokens(row.searchTerms);
    const all = [...name, ...terms];
    const score = coverage(query, all);
    if (score < SIM_THRESHOLD) continue;
    const type = typeOf(qt, searchTokens(row.commonName));
    scored.push({ row, score, type, tier: tierOf(qt, type, name, all, score), terms });
  }
  // Junk filter: a weak trigram match is a typo's safety net, not a peer of a real
  // hit. With anything better in the pool it only pads the menu ("copper spur" once
  // ended in a compass and a spoon cover). With nothing better it IS the answer for
  // a single word (a typo of one word looks like this) — but a multi-word query that
  // starts no word of any row is a custom name ("my car keys"), and twelve
  // look-alikes under it are noise: the menu stays shut and the typed text stands.
  const anyReal = scored.some((r) => r.tier < 3);
  const kept = anyReal ? scored.filter((r) => r.tier < 3) : qt.length > 1 ? [] : scored;
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
  const generic = scored.some((r) => r.type > 0 || runsIn(qt, r.terms));
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
  cap = 2000, // bounded; far above what one person realistically searches
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
