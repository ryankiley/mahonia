// Domain types shared by the client editor, the op-reducer, and the server/DB.

export type Unit = "g" | "kg" | "oz" | "lb";

/** All units in display order — the runtime companion to the `Unit` type. */
export const UNITS: Unit[] = ["g", "kg", "oz", "lb"];

// One field, not two booleans — structurally prevents "worn AND consumable".
// `base` counts toward base weight; `worn` = on your body; `consumable` = food/fuel/water.
export type Classification = "base" | "worn" | "consumable";

// How a folder orders its items. "manual" is the drag order (sortOrder); the rest are
// derived views recomputed on every render, so they stay sorted as items are
// added/edited. Absent/"manual" is the default — legacy folders (no field) read as
// manual, and manual is stored as absent to keep the folder payload lean.
export type FolderSort = "manual" | "name" | "heaviest" | "lightest";

export interface Folder {
  id: string; // client-generated (nanoid/uuid) so optimistic edits need no round-trip
  name: string;
  colorKey?: string; // maps to a `--cat-*` color token
  defaultClassification: Classification; // items inherit unless they override
  sortBy?: FolderSort; // per-folder item order (absent = "manual" drag order)
  sortOrder: number;
}

export interface Item {
  id: string; // client-generated
  folderId: string | null;
  // Nesting: the item this one is nested UNDER (a tent's fly/poles/stakes sit under the
  // tent). Absent/null = a top-level row. A nested item is a NORMAL item in every way —
  // same fields, same editor row, its own weight/qty/class/catalog link — it just renders
  // indented under its parent, and its parent's line shows the group total (own + kids).
  // Nesting is ONE level deep (a child can't itself be a parent); the reducer enforces it.
  // A child always shares its parent's folderId (kept in sync on nest/move).
  parentId?: string | null;
  name: string; // product name (the model, when brand/variant are split out)
  brand?: string; // company / maker
  variant?: string; // size/config qualifier (rendered dimmed); set from a catalog pick
  // the item's GEAR TYPE (the UI's word for it): a generic label for what this is
  // ("Tent", "Trail runners") — a quiet sub-line under the
  // product name. Independent of name/nameOverridden (which rename the PRODUCT) and of
  // description (a freeform note, which trails the common name on that same sub-line).
  // A catalog pick pre-fills this from the catalog's default; live-resolve keeps it fresh.
  commonName?: string;
  // true once the user renames/clears the common name → keep their text; don't let the
  // catalog live-resolve overwrite it with the catalog's default (mirrors nameOverridden)
  commonNameOverridden?: boolean;
  // true once the user free-renames a catalog-linked item → keep their text; don't
  // let live-resolve overwrite it with the catalog's current name (mirrors weightOverridden)
  nameOverridden?: boolean;
  unitWeightMg: number; // the user's truth for THIS list, integer milligrams
  weightOverridden?: boolean;
  // The unit this row's weight was TYPED in — display only. unitWeightMg stays the
  // one canonical store, so totals, sorting and exports are unaffected; this only
  // decides which unit the row renders back in. You buy gear labelled in whatever
  // the maker chose, so a metric list can hold a 3.8 oz stake set and still read in
  // grams at the bottom. Absent = fall back to the list's displayUnit, which is
  // exactly how every row behaved before this field existed.
  entryUnit?: Unit;
  qty: number;
  // of qty units, this many count as WORN; remainder = the row's effective class.
  // Only meaningful when the effective classification is "base" (a refinement of
  // the base line — NOT a second classification field). Absent/0 = no split. 0..qty.
  wornQty?: number;
  classification: Classification | null; // null = inherit folder default
  // Food energy for ONE unit, whole kcal — the calorie twin of unitWeightMg, so a
  // line is kcal × qty exactly as it is for weight. Only reachable, and only
  // counted, on rows whose EFFECTIVE classification is consumable: kcal on a tent
  // is a typo, and counting a value the row doesn't offer to edit would be a number
  // with no way back to its source. Flipping a row base → consumable therefore
  // brings a stored value back, which is what you'd want after a mis-click.
  kcal?: number;
  description?: string; // optional freeform user text
  productUrl?: string;
  imageUrl?: string;
  priceCents?: number;
  currency?: string;
  catalogItemId?: number; // linked catalog entry (set when chosen from autocomplete)
  catalogWeightMgAtLink?: number; // catalog weight at link time → powers the "catalog changed" nudge
  packed?: boolean;
  sortOrder: number;
}

/** The JSONB payload + the mutable content the op-reducer operates on. */
export interface ListData {
  folders: Folder[];
  items: Item[];
}

export interface ListMeta {
  title: string;
  description?: string;
  displayUnit: Unit;
  // Optional pointer to the route this list was packed for — any http(s) URL, stored
  // already normalized (see normalizeTrailUrl). trailLabel overrides the name derived
  // from the URL's path, for sites whose URLs are opaque (caltopo.com/m/ABC).
  trailUrl?: string;
  trailLabel?: string;
  // When the trip is. CALENDAR DATES, not instants: `YYYY-MM-DD`, no time and no
  // timezone. A trip's dates are the ones written on a permit — they don't shift
  // because you flew somewhere, which is exactly what storing an instant would do.
  //
  // Two optional strings and nothing else. This is NOT a trip planner: there are no
  // days, no waypoints, no itinerary. See the note in shared/ops.ts's setMeta case
  // for why the smaller thing was chosen deliberately.
  startDate?: string;
  endDate?: string;
}

/** Canonical wire shape returned by the API and held by the client editor. */
export interface ListSnapshot extends ListMeta, ListData {
  shareCode: string;
  slug: string;
  version: number;
  isPublic: boolean;
  // ISO timestamp of the server's last write to this list — drives the editor's
  // "edited Nm ago" line. Authoritative (reflects a collaborator's edit the poll
  // pulls in), unlike a device-local clock. Absent on a never-server-saved draft.
  updatedAt?: string;
  // The maker's chosen display name, when they made the list signed in AND set
  // one. Present only on the READ views — a byline is for people looking at
  // someone else's list. Absent means anonymous, which is the default and stays
  // the default: an account with no display name is never identified.
  authorName?: string;
  // public-feed metadata (only populated on the public read view / publish flow)
  tripType?: string;
  season?: string;
  publishedAt?: string;
  // The trail site's favicon as a data: URL, joined in from the per-host cache. Derived
  // data, not user content: it's absent from snapshots, diffs and the JSON export, and
  // queries that don't join simply leave it undefined (the link renders without a mark).
  trailFaviconDataUrl?: string;
}

/** The reducer's state: meta + content + version. */
export interface ListState extends ListMeta, ListData {
  version: number;
}

/** localStorage "My Lists" registry entry (no login). */
export interface MyListEntry {
  editToken: string;
  // How this list got here. "created" = this browser made, imported or cloned it;
  // "opened" = it arrived via someone else's edit link.
  //
  // This decides whether signing in ATTACHES the list to your account
  // automatically. Only your own lists should — quietly claiming a list someone
  // shared with you is a surprise, and it would outlive the owner's ability to
  // revoke the link.
  //
  // Absent on entries that predate the field. Those are treated as "created",
  // which is the right guess for the overwhelming majority and is safe because
  // rotating a list's link clears other accounts' claims.
  origin?: "created" | "opened";
  shareCode: string;
  slug: string;
  title: string;
  totalMg: number;
  version: number;
  lastOpened: number;
  // the list's chosen unit, so the "Your lists" summary reads in the same system
  // (metric/imperial) the list uses. Optional: legacy entries predate it and fall
  // back to metric auto-formatting.
  displayUnit?: Unit;
}

export interface Totals {
  totalMg: number;
  baseMg: number;
  wornMg: number;
  consumableMg: number;
  /** base + consumable — what's actually on your back. The three slices above
   *  partition the total; this one is a ROLL-UP of two of them, and it's the
   *  figure you compare against a pack's comfort rating. LighterPack makes you
   *  add it up in your head. */
  carriedMg: number;
  itemCount: number;
  hasWeights: boolean;
  /** Food energy across every CONSUMABLE line — see Item.kcal for why the class
   *  gates it. Not a slice of the weight partition above; it's a different unit
   *  entirely, and the UI renders it apart from the three chips for that reason. */
  kcalTotal: number;
  /** Does anything carry a calorie value? Mirrors hasWeights: it lets the UI stay
   *  silent on the overwhelming majority of lists, which will never use kcal, and
   *  distinguishes "nothing entered" from a genuine zero. */
  hasKcal: boolean;
}
