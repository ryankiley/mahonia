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

import { matchTier, rankByQuery, trigramScore } from "./catalogSearch";
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
 * The text a vault row is SEARCHED in, wider than the tier target (brand + name).
 * Variant is in it (you may well type "x-mid 2 pro"), and so is the GEAR TYPE —
 * "stove" has to find your PocketRocket, exactly as it finds the catalog's, or your
 * own gear is harder to search than a stranger's. commonName is the vault's
 * analogue of catalog_items.search_terms, and it's excluded from the tier target
 * for the same reason search_terms is: typing a category noun isn't typing the
 * name. The ranker scores this; the page's single-character substring pass
 * (shared/vaultView.ts) reads the same text, so the two can't find different rows.
 */
export function vaultSearchText(
  row: Pick<RankableVaultRow, "brand" | "name" | "variant" | "commonName">,
): string {
  return `${itemDisplayName(row.brand ?? null, row.name)} ${row.variant ?? ""} ${row.commonName ?? ""}`;
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
  return rankByQuery(
    rows,
    rawQuery,
    limit,
    (row, q) => {
      // the tier target is brand + name only — see vaultSearchText for what the
      // score reads and why the two differ
      const brandName = itemDisplayName(row.brand ?? null, row.name);
      const score = trigramScore(q, vaultSearchText(row));
      return { row, score, tier: matchTier(q, brandName, score) };
    },
    (a, b) =>
      a.tier - b.tier ||
      b.row.timesSeen - a.row.timesSeen ||
      b.score - a.score ||
      a.row.id - b.row.id,
  );
}
