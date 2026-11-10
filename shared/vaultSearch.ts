// Fuzzy ranking for vault gear — the SINGLE source of truth, shared by the server's
// autocomplete endpoint and by the two client surfaces that search a vault (the
// editor's pane and the /vault page). Pure + framework-agnostic, so it unit-tests
// without Nuxt or a database, and so a typo finds the same row wherever you type it.
//
// ITS OWN MODULE, not part of shared/vault.ts, for a bundle reason rather than a
// tidiness one. It needs the trigram scorer from shared/catalogSearch.ts, and
// shared/vault.ts is dynamically imported by the editor's CAPTURE path
// (useVault.ts wants captureFromList on every pause in typing) — folding the
// scorer in there would put it in that chunk, on a path that never searches
// anything. Splitting it means only a surface that actually searches pays.
// It lived in server/utils/vaultRepo.ts for the same reason, back when no client
// searched a vault locally; the pane's own search is what brought it here.

import { SIM_THRESHOLD, STRONG_THRESHOLD, coverage, runsIn, searchQuery, searchTokens } from "./catalogSearch";
import { enoughToSearch } from "./searchText";
import { VAULT_SEARCH_LIMIT } from "./vault";
import { itemDisplayName } from "./weights";

/** What ranking actually reads. Its own shape rather than Pick<VaultEntry>, so a raw
 *  DATABASE row fits too — the columns are nullable there and optional on VaultEntry,
 *  and the ranker only ever joins them through filter(Boolean). That lets the search
 *  rank rows and convert the survivors, instead of converting the whole pool first. */
export interface RankableVaultRow {
  id: number;
  brand?: string | null;
  name: string;
  variant?: string | null;
  commonName?: string | null;
  timesSeen: number;
}

/**
 * Rank vault rows, mirroring the catalog's cascade so the two halves of one menu
 * order by the same logic:
 *   tier ASC → timesSeen DESC → score DESC → id ASC
 * (the catalog's `verified` step has no analogue here — every row in your vault is
 * yours, so there's no trust axis to sort on.)
 *
 * Ranking in JS rather than SQL, for the same reason the catalog's is: a vault is
 * small and bounded per holder, so a whole-set scan is cheap and the ordering stays
 * identical across both database engines — and now across the client too.
 */
export function rankVaultRows<T extends RankableVaultRow>(
  rows: T[],
  rawQuery: string,
  limit = VAULT_SEARCH_LIMIT,
): T[] {
  return scoreVaultRows(rows, rawQuery)
    .slice(0, limit)
    .map(({ row }) => row);
}

/**
 * Only the rows a query actually NAMES: its words running in brand and name (tier 0
 * above), or nearly every trigram of it found in name, variant and gear type
 * (PICK_THRESHOLD, stricter than the tier-1 line, which "lighter" still cleared against
 * "Ultralight Mug Lid" because "lid" supplies the missing letters).
 *
 * For a picker, where a near miss is noise rather than help. rankVaultRows keeps weak
 * matches and orders them by how often you pack them, which in an autocomplete beside
 * the catalog is a fair guess, but in the kit dialog's item search it filled the slots
 * under "lighter" with a quilt and socks ("Ultralight" holds "light") and under "stove"
 * with your most-used gloves. A typo that misses here finds nothing, and the dialog
 * says so.
 */
export function strongVaultRows<T extends RankableVaultRow>(rows: T[], rawQuery: string, limit = VAULT_SEARCH_LIMIT): T[] {
  return scoreVaultRows(rows, rawQuery)
    .filter((r) => r.tier === 0 || r.score >= PICK_THRESHOLD)
    .slice(0, limit)
    .map(({ row }) => row);
}

/** The share of a query's trigrams a row must hold to be offered by a picker. */
const PICK_THRESHOLD = 0.8;

/** Every row the query reaches, scored and tiered, in rank order. */
function scoreVaultRows<T extends RankableVaultRow>(rows: T[], rawQuery: string): { row: T; score: number; tier: number }[] {
  const q = (rawQuery ?? "").trim();
  if (!enoughToSearch(q)) return []; // one character is too noisy for trigrams, unless it is a word
  const query = searchQuery(q);
  const scored: { row: T; score: number; tier: number }[] = [];
  for (const row of rows) {
    const brandName = itemDisplayName(row.brand ?? null, row.name);
    // The searchable target is wider than the tier target. Variant is in it (you
    // may well type "x-mid 2 pro"), and so is the GEAR TYPE — "stove" has to find
    // your PocketRocket, exactly as it finds the catalog's, or your own gear is
    // harder to search than a stranger's. commonName is the vault's analogue of
    // catalog_items.search_terms, and it's excluded from the tier target for the
    // same reason search_terms is: typing a category noun isn't typing the name.
    const score = coverage(query, searchTokens(`${brandName} ${row.variant ?? ""} ${row.commonName ?? ""}`));
    if (score < SIM_THRESHOLD) continue;
    const tier = runsIn(query.tokens, searchTokens(brandName)) ? 0 : score >= STRONG_THRESHOLD ? 1 : 2;
    scored.push({ row, score, tier });
  }
  return scored
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.row.timesSeen - a.row.timesSeen ||
        b.score - a.score ||
        a.row.id - b.row.id,
    );
}
