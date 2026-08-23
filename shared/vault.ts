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

import { foldForSearch } from "./catalogSearch";
import type { Classification, Item } from "./types";

/** Max vault suggestions returned to the autocomplete. Deliberately smaller than
 *  the catalog's SEARCH_LIMIT: the vault renders ABOVE the catalog results in the
 *  same menu, and your own gear shouldn't push the catalog off the first screen. */
export const VAULT_SEARCH_LIMIT = 6;

/** Hard cap on rows accepted by one capture request. A list far past this is
 *  pathological; the cap keeps a single POST bounded regardless. */
export const VAULT_CAPTURE_MAX = 200;

/** Field caps, applied on the way in so an oversized list row can't bloat a vault
 *  row. Mirrors the reducer's own clamping intent (shared/ops.ts). Exported so the
 *  server's sanitize (vaultRepo) clamps a direct POST to the same bounds the
 *  client applies — one set of numbers, not two. */
export const VAULT_NAME_MAX = 200;
export const VAULT_SHORT_MAX = 120;
export const VAULT_URL_MAX = 2000;
/** A note's cap, taking the list Item's own (cleanItemPatch's 2000) rather than a
 *  second number — it is the same text, moved. */
export const VAULT_NOTE_MAX = 2000;

/**
 * A piece of gear as the client offers it up for capture — the subset of a list
 * Item that describes the GEAR rather than its role in one particular list.
 * Deliberately omits qty, sortOrder, packed, wornQty and personId: those are
 * facts about a list (who carries the stove on THIS trip is not a property of
 * the stove), not about the thing you own. Folder is the exception, and carried
 * by NAME rather than by the list's folder id — see the field below.
 */
export interface VaultCapture {
  normKey: string;
  brand?: string;
  name: string;
  variant?: string;
  commonName?: string;
  weightMg: number;
  classification?: Classification;
  /** Food energy for ONE unit, whole kcal — the calorie twin of weightMg. A fact
   *  about the food itself (a bar is 250 kcal in any list), so it belongs to the
   *  gear the way weight does: captured here, it comes back pre-filled the next
   *  time the same food is picked. Absent = never entered, mirroring Item.kcal. */
  kcal?: number;
  catalogItemId?: number;
  productUrl?: string;
  /** Your note about the gear — the list Item's `description`, which capture used
   *  to drop on the floor. Ambiguous by nature (a row's note is sometimes about the
   *  trip: "Sam carries this"), and the answer to that is the same one the other
   *  coalesced fields get: the FIRST note wins, and correcting it on /gear pins it
   *  so no later list can argue. */
  description?: string;
  /** What it cost, in whole cents of `currency`. Recorded on the gear rather than on
   *  a list row, because a price is a fact about the thing you bought — and because
   *  the list side has been waiting for it: NameCommit already declares priceCents
   *  "when it came from the vault", against a vault that had nowhere to keep one. */
  priceCents?: number;
  /** ISO 4217 for priceCents, when it's known. Moves with the price and is pinned
   *  with it — "$399" is one decision, not two. */
  currency?: string;
  /** A picture of the product, from wherever the row's own imageUrl came from (a
   *  LighterPack import, a JSON backup). Carried for fidelity and for the export;
   *  nothing renders it yet, and whether the vault should is a separate decision
   *  from whether it should keep what it was handed. */
  imageUrl?: string;
  /** The NAME of the list folder this gear sat in, so a vault fills itself
   *  organised instead of arriving as one flat pile. A name, not an id: list
   *  folder ids are per-list, and the same "Shelter" in two lists should mean one
   *  vault folder. The server files a row on FIRST capture only, so a later list
   *  that groups differently can't reshuffle what you've already filed. */
  folder?: string;
}

/** A vault folder as the API returns it. Deliberately smaller than a list Folder:
 *  no colorKey, no defaultClassification — those describe how a LIST presents and
 *  classifies rows, and a vault row already carries its own classification. */
export interface VaultFolder {
  id: number;
  name: string;
}

/**
 * The fields a /gear edit can PIN.
 *
 * Editing one is a statement that your value is the truth about your own gear, and
 * captureVaultItems coalesces around a pinned field instead of overwriting it — the
 * gear's counterpart to the list Item's weightOverridden / nameOverridden, which
 * say the same thing to the catalog.
 *
 * One token per independent decision, which is why brand/name/variant share `name`:
 * they are one spelling of one identity, and a capture rewrites all three together
 * or none. Keeping them apart would let a list revert your corrected variant while
 * your corrected brand stood, which is not a state anyone asked for.
 */
export const VAULT_PIN_FIELDS = [
  "name",
  "weight",
  "commonName",
  "classification",
  "kcal",
  "productUrl",
  "description",
  // one token for priceCents + currency, on the same rule that gives brand/name/
  // variant one: an amount and the money it's in are one decision, and a capture
  // that could revert the currency under a kept number would invent a price
  "price",
] as const;
export type VaultPinField = (typeof VAULT_PIN_FIELDS)[number];

/** A stored gear row as the API returns it. */
export interface VaultEntry extends VaultCapture {
  /** which vault folder it's filed under; absent = unfiled */
  folderId?: number;
  /** Which fields you've corrected by hand, so capture leaves them alone. Absent =
   *  nothing pinned, which is every row only a list has ever written. */
  pinned?: VaultPinField[];
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
function captureFromItem(
  item: Item,
  hasChildren: boolean,
  folderName?: string,
): VaultCapture | null {
  if (!isVaultWorthy(item, hasChildren)) return null;
  // non-empty by isVaultWorthy's first test, so no re-guard
  const name = item.name.trim().slice(0, VAULT_NAME_MAX);
  const brand = trim(item.brand, VAULT_SHORT_MAX);
  const variant = trim(item.variant, VAULT_SHORT_MAX);
  const normKey = vaultNormKey(brand, name, variant);
  if (!normKey) return null;
  return {
    normKey,
    brand,
    name,
    variant,
    commonName: trim(item.commonName, VAULT_SHORT_MAX),
    weightMg: Math.max(0, Math.round(item.unitWeightMg)),
    // null means "inherit the folder default" — a fact about the list, not the
    // gear, so it's dropped rather than guessed at
    classification: item.classification ?? undefined,
    // carried whenever entered — the row's class may hide the value today, but the
    // value itself never stops being true of the food (see Item.kcal)
    kcal: typeof item.kcal === "number" && item.kcal > 0 ? Math.round(item.kcal) : undefined,
    catalogItemId: typeof item.catalogItemId === "number" ? item.catalogItemId : undefined,
    productUrl: trim(item.productUrl, VAULT_URL_MAX),
    description: trim(item.description, VAULT_NOTE_MAX),
    // a price of zero is "free", which nobody records, so it reads as absent —
    // the same shape kcal takes above
    priceCents:
      typeof item.priceCents === "number" && item.priceCents > 0
        ? Math.round(item.priceCents)
        : undefined,
    // only alongside an amount: a currency on its own says nothing and would
    // survive in the row as a unit with no figure
    currency:
      typeof item.priceCents === "number" && item.priceCents > 0
        ? trim(item.currency, 8)
        : undefined,
    imageUrl: trim(item.imageUrl, VAULT_URL_MAX),
    folder: trim(folderName, VAULT_SHORT_MAX),
  };
}

/**
 * Every distinct piece of gear in a list, ready to capture.
 *
 * Deduped by normKey WITHIN the list: a list that carries two 500 ml bottles as
 * separate rows is still one bottle in your vault. The LAST occurrence wins, so a
 * row you've just corrected beats an older duplicate above it.
 */
export function captureFromList(
  items: Item[],
  folders: { id: string; name: string }[] = [],
): VaultCapture[] {
  const parents = new Set<string>();
  for (const i of items) if (i.parentId) parents.add(i.parentId);
  // folder id → name, so each row can carry the name of the group it sat in
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const byKey = new Map<string, VaultCapture>();
  for (const item of items) {
    const cap = captureFromItem(
      item,
      parents.has(item.id),
      item.folderId ? folderName.get(item.folderId) : undefined,
    );
    if (cap) byKey.set(cap.normKey, cap);
  }
  return [...byKey.values()].slice(0, VAULT_CAPTURE_MAX);
}

/**
 * A stable fingerprint of a capture set, so the client only re-sends when
 * something a vault row would actually store has changed. Without it, the editor's
 * every-keystroke snapshot would POST the whole list on each pause; with it, a
 * session that adds one item sends once.
 *
 * Every field the upsert stores is here — including the SPELLING of
 * brand/name/variant, not just their folded normKey, because the vault takes the
 * incoming spelling: fixing "zpacks duplex" to "Zpacks Duplex" is a change worth
 * sending even though it lands on the same row.
 */
export function captureFingerprint(caps: VaultCapture[]): string {
  return caps
    .map((c) =>
      [
        c.normKey,
        c.brand ?? "",
        c.name,
        c.variant ?? "",
        c.weightMg,
        c.classification ?? "",
        c.kcal ?? "",
        c.catalogItemId ?? "",
        c.commonName ?? "",
        c.productUrl ?? "",
        c.description ?? "",
        c.priceCents ?? "",
        c.currency ?? "",
        c.imageUrl ?? "",
        c.folder ?? "",
      ].join(
        "",
      ),
    )
    .sort()
    .join("");
}
