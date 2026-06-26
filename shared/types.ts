// Domain types shared by the client editor, the op-reducer, and the server/DB.

export type Unit = "g" | "kg" | "oz" | "lb";

/** All units in display order — the runtime companion to the `Unit` type. */
export const UNITS: Unit[] = ["g", "kg", "oz", "lb"];

// One field, not two booleans — structurally prevents "worn AND consumable".
// `base` counts toward base weight; `worn` = on your body; `consumable` = food/fuel/water.
export type Classification = "base" | "worn" | "consumable";

export interface Folder {
  id: string; // client-generated (nanoid/uuid) so optimistic edits need no round-trip
  name: string;
  colorKey?: string; // maps to a `--cat-*` color token
  defaultClassification: Classification; // items inherit unless they override
  sortOrder: number;
}

export interface Item {
  id: string; // client-generated
  folderId: string | null;
  name: string; // product name
  brand?: string; // company / maker
  unitWeightMg: number; // the user's truth for THIS list, integer milligrams
  weightOverridden?: boolean;
  qty: number;
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
}

export interface Totals {
  totalMg: number;
  baseMg: number;
  wornMg: number;
  consumableMg: number;
  itemCount: number;
  hasWeights: boolean;
}
