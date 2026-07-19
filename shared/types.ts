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
  // user's generic label for what this is ("Tent", "Shoes") — a quiet sub-line under the
  // product name. Independent of name/nameOverridden (which rename the PRODUCT) and of
  // description (a freeform note, which trails the common name on that same sub-line).
  commonName?: string;
  // true once the user free-renames a catalog-linked item → keep their text; don't
  // let live-resolve overwrite it with the catalog's current name (mirrors weightOverridden)
  nameOverridden?: boolean;
  unitWeightMg: number; // the user's truth for THIS list, integer milligrams
  weightOverridden?: boolean;
  qty: number;
  // of qty units, this many count as WORN; remainder = the row's effective class.
  // Only meaningful when the effective classification is "base" (a refinement of
  // the base line — NOT a second classification field). Absent/0 = no split. 0..qty.
  wornQty?: number;
  classification: Classification | null; // null = inherit folder default
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
  // public-feed metadata (only populated on the public read view / publish flow)
  tripType?: string;
  season?: string;
  publishedAt?: string;
}

/** The reducer's state: meta + content + version. */
export interface ListState extends ListMeta, ListData {
  version: number;
}

/** localStorage "My Lists" registry entry (no login). */
export interface MyListEntry {
  editToken: string;
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
  itemCount: number;
  hasWeights: boolean;
}
