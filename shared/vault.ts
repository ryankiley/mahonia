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

import type { GearGlyph } from "./gearGlyph";
import { foldForSearch } from "./searchText";
import type { Classification, Item, Unit } from "./types";

/** Max vault suggestions returned to the autocomplete. Deliberately smaller than
 *  the catalog's SEARCH_LIMIT: the vault renders ABOVE the catalog results in the
 *  same menu, and your own gear shouldn't push the catalog off the first screen. */
export const VAULT_SEARCH_LIMIT = 6;

/** Hard cap on rows accepted by one IMPORT. Matches the read ceiling in vaultRepo,
 *  so a backup taken from a vault you could actually see always fits back in. */
export const VAULT_IMPORT_MAX = 1000;

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
  /** What it cost, in whole cents of `currency`. Recorded on the gear rather than on
   *  a list row, because a price is a fact about the thing you bought — and because
   *  the list side has been waiting for it: NameCommit already declares priceCents
   *  "when it came from the vault", against a vault that had nowhere to keep one. */
  priceCents?: number;
  /** ISO 4217 for priceCents, when it's known. Moves with the price and is pinned
   *  with it — "$399" is one decision, not two. */
  currency?: string;
  /** The NAME of the list folder (or file category) this gear sat in, for the
   *  chooser to group its rows under. My Gear itself has no folders — it groups by
   *  kind — so the server stores nothing from it. */
  folder?: string;
  /** True when brand/name/variant are the catalog's own text, untouched since the
   *  pick (linked, not renamed). The server then captures the row under the catalog's
   *  CURRENT spelling, so a list saved before a catalog tidy can't mint a second row
   *  for the same product (vaultRepo's respellCatalogPicks). Never stored. */
  catalogSpelling?: boolean;
}

/**
 * How the vault reports WHAT IT HOLDS, to the one client that asks: the gear's
 * identity key, and the weight a capture could still write into it — null when
 * that weight is pinned and no capture may argue with it.
 *
 * Named and shared because two endpoints return it (the membership read, and
 * capture's answer about what actually landed) and the editor folds both into one
 * Map. When those two drifted — one returning bare keys while the client
 * destructured tuples — every successful save reported itself as refused, and the
 * automatic path wrote single characters into the Map. A cast at the fetch is not
 * a check; a shared name at least makes the contract greppable from both sides.
 */
export type VaultGearKey = [normKey: string, weightMg: number | null, kind?: "kit"];

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
  // one token for priceCents + currency, on the same rule that gives brand/name/
  // variant one: an amount and the money it's in are one decision, and a capture
  // that could revert the currency under a kept number would invent a price
  "price",
] as const;
export type VaultPinField = (typeof VAULT_PIN_FIELDS)[number];

/** The most of one piece My Gear will count: past this a typo is likelier than a closet. */
export const OWNED_MAX = 999;

/**
 * A count of owned pieces off the wire, a file or a column, as it's stored: a whole
 * number 2..OWNED_MAX, or undefined for one (and for anything that isn't a count), so
 * "one" has a single representation and a row that says nothing means one.
 */
export function ownedOf(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.min(OWNED_MAX, Math.round(v));
  return n > 1 ? n : undefined;
}

/** A stored gear row as the API returns it. */
export interface VaultEntry extends VaultCapture, VaultKitFields {
  /** Which fields you've corrected by hand, so capture leaves them alone. Absent =
   *  nothing pinned, which is every row only a list has ever written. */
  pinned?: VaultPinField[];
  /** The icon you picked for it by hand; absent = drawn from its gear type. */
  icon?: GearGlyph;
  /** The unit its weight reads in, picked per piece like a list row's entryUnit;
   *  absent = the page's unit. Display only: weightMg is the figure. */
  entryUnit?: Unit;
  /** How many of it you own, when that's more than one; absent = one. A fact about
   *  your closet, not about a trip (a list's qty is how many you carry). */
  owned?: number;
  id: number;
  /** How many distinct captures have landed on this row — a "how often do I pack
   *  this" signal that ranks the autocomplete, like the catalog's usage_count. */
  timesSeen: number;
  lastUsedAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// kits
// ---------------------------------------------------------------------------
// A KIT is a set you itemize: a cook kit that is a stove, a pot and a lighter. It is
// a vault row like any other — a name and its parts — whose weight is its parts'.
// A thing you weigh whole and never itemize (the first-aid pouch you never open) is
// not a kit; it is a piece with a weight, which the vault has always held.
//
// What a kit is FOR is the list. A list already nests one level — a row with rows
// under it is a group, and the group's line shows the total — and My Gear used to
// refuse exactly that shape (see isVaultWorthy): the set you built on a trip was
// remembered as its pieces and forgotten as a set. A kit is that group, kept. It is
// made from a group (kitFromGroup, behind the group row's own Save to My Gear) or by
// hand on /gear, and it goes back onto a list as a group — a parent row carrying the
// kit's own weight, each part a real child row you can drop, assign or annotate for
// that trip.
//
// One level deep, like the list: a part is always a piece. A piece may sit in several
// kits (the lighter in the cook kit and the fire kit), and totals count it once,
// where it is filed. The arithmetic and the builder live in vaultKit.ts, off the
// editor's first load; the types and the row's own gate (isKitWorthy) live here.

type VaultKind = "piece" | "kit";

/** One part of a kit as a read hands it back: which piece, how many, and enough of
 *  the piece to draw it under the kit — a put-away part is not in the live list the
 *  page holds, and it is still listed here, flagged. */
export interface VaultKitPart {
  id: number;
  qty: number;
  brand?: string;
  name: string;
  variant?: string;
  /** ONE unit of the part, as the part row stores it */
  weightMg: number;
  /** put away on /gear: still listed under the kit, no longer counted */
  removed?: boolean;
}

/** The kit fields a read adds to an entry. On a kit the entry's own `weightMg` is the
 *  DERIVED total (own + live parts × qty), so anything that shows or sorts one row
 *  sees the true figure; a TOTAL over rows reckons it apart (vaultKit.ts). */
export interface VaultKitFields {
  /** absent on a piece */
  kind?: "kit";
  /** a kit's own weight (the stuff sack), as stored — usually 0 */
  ownWeightMg?: number;
  /** a kit's parts, in the kit's order, put-away ones included and flagged */
  parts?: VaultKitPart[];
  /** a piece's live kits, by id; absent when it is in none */
  inKits?: number[];
}

/** A part named the way a capture can name it: by the gear's identity, with the
 *  count the group carried. Ids belong to the vault, and a list has none. */
export interface VaultKitPartRef {
  normKey: string;
  qty: number;
}

/** A group row offered to the vault as a kit: the parent as gear (its weightMg is
 *  the group's OWN weight, the stuff sack), plus which of the children are its parts. */
export interface VaultKitCapture extends VaultCapture {
  parts: VaultKitPartRef[];
}

function trim(v: string | undefined | null, max: number): string | undefined {
  const s = (v ?? "").trim();
  return s ? s.slice(0, max) : undefined;
}

/**
 * The identity of a piece of gear: brand + name + variant, run through the same
 * fold the catalog search uses (NFD → strip diacritics → lowercase → collapse
 * anything that isn't a letter or digit). So "Zpacks Duplex", "zpacks  duplex" and
 * "ZPACKS DUPLEX!" are one row, and an accented brand folds to its plain spelling.
 * A letter is a letter in any script: "登山杖（裸杖）" and "登山杖（含配件）" are two
 * rows, and a name written only in Chinese is a row at all, rather than folding
 * to "" and never being kept.
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

/** The vault identities a list's rows already hold — the set three surfaces ask
 *  before offering a row (the pane's "already added", a kit unfolding onto a list,
 *  the capture's own ledger). Nameless rows have no identity and are skipped. */
export function listNormKeys(
  items: readonly { brand?: string | null; name?: string | null; variant?: string | null }[],
): Set<string> {
  const keys = new Set<string>();
  for (const it of items) {
    const key = vaultNormKey(it.brand, it.name, it.variant);
    if (key) keys.add(key);
  }
  return keys;
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
export function isWaterRow(item: Item): boolean {
  return item.classification === "consumable" && foldForSearch(item.name) === "water";
}

/**
 * Project a list Item onto the gear it describes, asking only whether it has a
 * NAME — not whether a live editor ought to be banking it.
 *
 * Split out from captureFromItem for the import path, where isVaultWorthy's rules
 * are wrong: it exists to keep a half-typed row out of your vault while you are
 * still typing it, and nothing in a file you deliberately chose is half-typed. Its
 * weight test in particular would drop every un-weighed row in a gear CSV — gear
 * you own and haven't put on the scale — which would quietly break the round trip
 * the export advertises.
 */
export function gearFromItem(item: Item, folderName?: string): VaultCapture | null {
  if (!item.name.trim()) return null;
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
    folder: trim(folderName, VAULT_SHORT_MAX),
  };
}

/** Project a list Item as CAPTURE sees it: the projection above, behind the rule
 *  about which rows an open editor should be banking at all, and marked when its
 *  text is still the catalog's. Here and not in gearFromItem: an imported file says
 *  nothing about whether its names were ever edited, so it is never respelled. */
function captureFromItem(
  item: Item,
  hasChildren: boolean,
  folderName?: string,
): VaultCapture | null {
  if (!isVaultWorthy(item, hasChildren)) return null;
  const cap = gearFromItem(item, folderName);
  return cap && { ...cap, catalogSpelling: item.catalogItemId != null && !item.nameOverridden };
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
 * Could this group row be saved as a KIT — the render gate for its save button, the
 * way isVaultWorthy is for a piece's. A named group that isn't water, holding at
 * least one child that is gear in its own right (and isn't the group's own name).
 *
 * Its own small test rather than "would kitFromGroup build one": this runs on every
 * group row, so it lives here, in the module every row loads; the builder only runs
 * on the press, and lives with the rest of the kit code (vaultKit.ts), off that path.
 */
export function isKitWorthy(parent: Item, children: readonly Item[]): boolean {
  if (isWaterRow(parent)) return false;
  const own = vaultNormKey(parent.brand, parent.name, parent.variant);
  return (
    !!own &&
    children.some((c) => {
      if (c.parentId !== parent.id || !isVaultWorthy(c, false)) return false;
      const key = vaultNormKey(c.brand, c.name, c.variant);
      return !!key && key !== own;
    })
  );
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
        c.priceCents ?? "",
        c.currency ?? "",
      ].join(
        "",
      ),
    )
    .sort()
    .join("");
}

/** What a piece of My Gear brings to a list row: the fields a name-field pick
 *  (ItemRow's onNameCommit) and the gear pane's add (useGearList's addVaultItem, a kit's
 *  items included) both put on the row. */
export interface VaultPick {
  name: string;
  brand?: string;
  variant?: string;
  commonName?: string;
  weightMg?: number;
  catalogItemId?: number;
  kcal?: number;
  priceCents?: number;
  currency?: string;
  productUrl?: string;
  entryUnit?: Unit;
}

/**
 * A piece of My Gear as list-row fields, the ONE rule both ways onto a list take. They
 * were two hand-kept copies, and the pane's lost the unit the piece reads in on /gear
 * while the pick carried it.
 *
 * Every value is the holder's own, so the name, a weight and a gear type are marked
 * overridden and the catalog's live-resolve leaves them alone; the catalog link rides
 * along for provenance. A field the gear doesn't have is left out, never cleared: on a
 * row being renamed that keeps what the row already says, and a new row has nothing to
 * keep. A weight of 0 is "not weighed yet", so it brings no weight (and no unit). No
 * note: a row's note is about the trip, and My Gear keeps none.
 */
export function vaultRowFields(v: VaultPick): Partial<Item> {
  return {
    name: v.name,
    nameOverridden: true,
    ...(v.brand ? { brand: v.brand } : {}),
    ...(v.variant ? { variant: v.variant } : {}),
    ...(v.catalogItemId != null ? { catalogItemId: v.catalogItemId } : {}),
    ...(v.weightMg != null && v.weightMg > 0
      ? { unitWeightMg: v.weightMg, weightOverridden: true, ...(v.entryUnit ? { entryUnit: v.entryUnit } : {}) }
      : {}),
    ...(v.commonName ? { commonName: v.commonName, commonNameOverridden: true } : {}),
    ...(v.priceCents != null ? { priceCents: v.priceCents, currency: v.currency } : {}),
    ...(v.productUrl ? { productUrl: v.productUrl } : {}),
    ...(v.kcal != null ? { kcal: v.kcal } : {}),
  };
}

/** What you can do to a vault ROW from /gear — see server/api/vault/items.post.ts.
 *  Here rather than beside the repo that applies it, so the page's calls are typed
 *  by the same union the endpoint reads. */
export type VaultItemOp =
  | {
      t: "add";
      brand?: string;
      name: string;
      variant?: string;
      commonName?: string;
      /** Absent or 0 = not weighed yet, a normal state for gear you've just
       *  remembered you own. A zero pins nothing — see cleanVaultPatch. */
      weightMg?: number;
      classification?: Classification;
      kcal?: number;
      /** The catalog row the piece is a pick of, when it is one: what a captured pick
       *  carries, stated by hand. Bounded by sanitize() like a capture's. */
      catalogItemId?: number;
      productUrl?: string;
      priceCents?: number;
      currency?: string;
      /** The unit its weight was typed in ("3.8 oz"), so it reads back the same way. */
      entryUnit?: Unit;
      /** How many you own; absent is one. */
      owned?: number;
    }
  | {
      t: "edit";
      id: number;
      patch: VaultItemPatch;
      /** Release a pin, so a list can teach the field again. The only way back from
       *  a pin — without it one correction would freeze a field forever. Applied
       *  AFTER the patch's own pins, so `{ patch: { weightMg: 545 }, unpin:
       *  ["weight"] }` reads as "set it, but keep taking my lists' word for it". */
      unpin?: VaultPinField[];
    }
  | {
      t: "kit";
      id: number;
      /** The kit's pieces, in its order — they REPLACE whatever it held. Empty turns
       *  a kit back into a piece (see clearKit). */
      parts: { id: number; qty?: number }[];
      /** The kit's own weight (the stuff sack); absent = 0. Unread when `parts` is
       *  empty, since the piece it becomes keeps the total it showed. */
      ownWeightMg?: number;
    };

/**
 * A field ABSENT here is untouched; present, it is set AND pinned; null (or a
 * string that tidies to "") CLEARS it and pins the emptiness — otherwise deleting a
 * bogus product URL would be undone by the next capture's coalesce. The same
 * semantics cleanItemPatch gives a list row in shared/ops.
 *
 */
export interface VaultItemPatch {
  brand?: string | null;
  name?: string;
  variant?: string | null;
  commonName?: string | null;
  weightMg?: number;
  classification?: Classification | null;
  kcal?: number | null;
  productUrl?: string | null;
  /** The amount, in cents. 0 or null clears it — and clears the currency with it,
   *  since the two are one decision (VAULT_PIN_FIELDS' `price`). */
  priceCents?: number | null;
  /** Only read alongside a priceCents. On its own it would set the money a stored
   *  amount is in without the amount being restated, which is how "£399" becomes
   *  "$399" by editing a field the dialog didn't show you. */
  currency?: string | null;
  /** Link the piece to a catalog row, or null to unlink it. No pin: a link is a fact
   *  about which product this is, not a value a list could argue with. */
  catalogItemId?: number | null;
  /** The icon picked by hand, or null to go back to the gear type's. No pin, like the
   *  catalog link: nothing but this dialog ever writes it. */
  icon?: GearGlyph | null;
  /** The unit the weight reads in, or null for the page's. No pin: only /gear writes
   *  it, so there is no capture to protect it from. */
  entryUnit?: Unit | null;
  /** How many you own; 1 or null goes back to one. No pin, for entryUnit's reason. */
  owned?: number | null;
}
