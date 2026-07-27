// The vault — a signed-in user's own gear locker, accumulated from the lists they
// build. Pure + framework-agnostic (unit-tested), shared by the client capture
// path, the server upsert, and the autocomplete ranker, so the identity rule that
// decides "is this the same piece of gear" is written down exactly once.
//
// WHY A SEPARATE IDENTITY FROM THE CATALOG: the catalog is a curated, cited spine
// of products that exist in the world. The vault is the gear *you* own — including
// the hand-typed rows that will never be in a catalog (a MYOG quilt, a repackaged
// first-aid kit) and your own measured weight for a product whose spec sheet lies.
// So a vault row is keyed by its TEXT, not by a catalog id: two list rows are the
// same gear when their brand + name + variant fold to the same string.

import {
  SIM_THRESHOLD,
  foldForSearch,
  matchTier,
  trigramScore,
} from "./catalogSearch";
import type { Classification, Item } from "./types";
import { itemDisplayName } from "./weights";

/** Max vault suggestions returned to the autocomplete. Deliberately smaller than
 *  the catalog's SEARCH_LIMIT: the vault renders ABOVE the catalog results in the
 *  same menu, and your own gear shouldn't push the catalog off the first screen. */
export const VAULT_SEARCH_LIMIT = 6;

/** Hard cap on rows accepted by one capture request. A list far past this is
 *  pathological; the cap keeps a single POST bounded regardless. */
export const VAULT_CAPTURE_MAX = 200;

/** Field caps, applied on the way in so an oversized list row can't bloat a vault
 *  row. Mirrors the reducer's own clamping intent (shared/ops.ts). */
const NAME_MAX = 200;
const SHORT_MAX = 120;

/**
 * A piece of gear as the client offers it up for capture — the subset of a list
 * Item that describes the GEAR rather than its role in one particular list.
 * Deliberately omits qty, folderId, sortOrder, packed and wornQty: those are facts
 * about a list, not about the thing you own.
 */
export interface VaultCapture {
  normKey: string;
  brand?: string;
  name: string;
  variant?: string;
  commonName?: string;
  weightMg: number;
  classification?: Classification;
  catalogItemId?: number;
  productUrl?: string;
  priceCents?: number;
  currency?: string;
}

/** A stored vault row as the API returns it. */
export interface VaultEntry extends VaultCapture {
  id: number;
  /** How many distinct captures have landed on this row — a "how often do I pack
   *  this" signal that ranks the autocomplete, like the catalog's usage_count. */
  timesSeen: number;
  lastUsedAt: string;
  createdAt: string;
}

function trim(v: string | undefined | null, max: number): string | undefined {
  const s = (v ?? "").trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * The identity of a piece of gear: brand + name + variant, run through the same
 * fold the catalog search uses (NFD → strip diacritics → lowercase → collapse
 * non-alphanumerics). So "Zpacks Duplex", "zpacks  duplex" and "ZPACKS DUPLEX!"
 * are one row, and an accented brand folds to its plain spelling.
 *
 * Returns "" for a nameless row — callers treat that as "not vault-worthy".
 */
export function vaultNormKey(
  brand: string | undefined | null,
  name: string | undefined | null,
  variant: string | undefined | null,
): string {
  if (!(name ?? "").trim()) return "";
  return foldForSearch([brand, name, variant].filter(Boolean).join(" "));
}

/**
 * Is this list row a piece of gear worth remembering?
 *
 * Three exclusions, each for a reason:
 *  • no name — a blank row the user is still typing into;
 *  • a GROUP (a row with children) — "Cook kit" is a container, not gear. Its
 *    children are the real items and they're captured on their own;
 *  • water — derived from a volume, not something you own; it would land in every
 *    vault as a meaningless "Water" row.
 *
 * A weight of zero is fine as long as the row is a catalog pick (you added real
 * gear, the weight just hasn't been filled in) — but an un-weighed, un-linked row
 * is indistinguishable from a half-typed thought, so it waits until it has one or
 * the other.
 */
export function isVaultWorthy(item: Item, hasChildren: boolean): boolean {
  if (!item.name.trim()) return false;
  if (hasChildren) return false;
  if (isWaterRow(item)) return false;
  return item.unitWeightMg > 0 || item.catalogItemId != null;
}

/** Water is the one list row the editor synthesises from a volume (see
 *  shared/water.ts) — never gear. */
function isWaterRow(item: Item): boolean {
  return item.classification === "consumable" && foldForSearch(item.name) === "water";
}

/** Project a list Item onto the gear it describes. Returns null when the row isn't
 *  vault-worthy, so callers can map-and-filter in one pass. */
export function captureFromItem(item: Item, hasChildren: boolean): VaultCapture | null {
  if (!isVaultWorthy(item, hasChildren)) return null;
  const name = trim(item.name, NAME_MAX);
  if (!name) return null;
  const brand = trim(item.brand, SHORT_MAX);
  const variant = trim(item.variant, SHORT_MAX);
  const normKey = vaultNormKey(brand, name, variant);
  if (!normKey) return null;
  return {
    normKey,
    brand,
    name,
    variant,
    commonName: trim(item.commonName, SHORT_MAX),
    weightMg: Math.max(0, Math.round(item.unitWeightMg)),
    // null means "inherit the folder default" — a fact about the list, not the
    // gear, so it's dropped rather than guessed at
    classification: item.classification ?? undefined,
    catalogItemId: typeof item.catalogItemId === "number" ? item.catalogItemId : undefined,
    productUrl: trim(item.productUrl, 2000),
    priceCents: typeof item.priceCents === "number" ? item.priceCents : undefined,
    currency: trim(item.currency, 8),
  };
}

/**
 * Every distinct piece of gear in a list, ready to capture.
 *
 * Deduped by normKey WITHIN the list: a list that carries two 500 ml bottles as
 * separate rows is still one bottle in your vault. The LAST occurrence wins, so a
 * row you've just corrected beats an older duplicate above it.
 */
export function captureFromList(items: Item[]): VaultCapture[] {
  const parents = new Set<string>();
  for (const i of items) if (i.parentId) parents.add(i.parentId);
  const byKey = new Map<string, VaultCapture>();
  for (const item of items) {
    const cap = captureFromItem(item, parents.has(item.id));
    if (cap) byKey.set(cap.normKey, cap);
  }
  return [...byKey.values()].slice(0, VAULT_CAPTURE_MAX);
}

/**
 * A stable fingerprint of a capture set, so the client only re-sends when
 * something a vault row would actually store has changed. Without it, the editor's
 * every-keystroke snapshot would POST the whole list on each pause; with it, a
 * session that adds one item sends once.
 */
export function captureFingerprint(caps: VaultCapture[]): string {
  return caps
    .map((c) =>
      [c.normKey, c.weightMg, c.classification ?? "", c.catalogItemId ?? "", c.commonName ?? ""].join(
        "",
      ),
    )
    .sort()
    .join("");
}

/** A vault row as the ranker needs it — the entry plus nothing else; timesSeen is
 *  already on VaultEntry and stands in for the catalog's usage_count. */
export type RankableVaultRow = Pick<
  VaultEntry,
  "id" | "brand" | "name" | "variant" | "commonName" | "timesSeen"
>;

/**
 * Rank vault rows for the autocomplete, mirroring the catalog's cascade so the two
 * halves of one menu order by the same logic:
 *   tier ASC → timesSeen DESC → score DESC → id ASC
 * (the catalog's `verified` step has no analogue here — every row in your vault is
 * yours, so there's no trust axis to sort on.)
 *
 * Ranking lives here, not in SQL, for the same reason the catalog's does: the
 * vault is small and bounded per user, so a whole-set scan is cheap and the
 * ordering stays identical on both database engines.
 */
export function rankVaultRows<T extends RankableVaultRow>(
  rows: T[],
  rawQuery: string,
  limit = VAULT_SEARCH_LIMIT,
): T[] {
  const q = (rawQuery ?? "").trim();
  if (q.length < 2) return []; // one character is too noisy for trigram autocomplete
  return rows
    .map((row) => {
      const brandName = itemDisplayName(row.brand ?? null, row.name);
      // The searchable target is wider than the tier target. Variant is in it (you
      // may well type "x-mid 2 pro"), and so is the GEAR TYPE — "stove" has to find
      // your PocketRocket, exactly as it finds the catalog's, or your own gear is
      // harder to search than a stranger's. commonName is the vault's analogue of
      // catalog_items.search_terms, and it's excluded from the tier target for the
      // same reason search_terms is: typing a category noun isn't typing the name.
      const score = trigramScore(q, `${brandName} ${row.variant ?? ""} ${row.commonName ?? ""}`);
      return { row, score, tier: matchTier(q, brandName, score) };
    })
    .filter((r) => r.score >= SIM_THRESHOLD)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        b.row.timesSeen - a.row.timesSeen ||
        b.score - a.score ||
        a.row.id - b.row.id,
    )
    .slice(0, limit)
    .map(({ row }) => row);
}
