// Mutation operations — the SINGLE source of truth for how a list changes.
// The same reducer runs on the client (optimistic) and the server
// (authoritative), so the two states can never drift. Ops are designed to
// MERGE: two editors adding different items both succeed with no conflict; the
// version counter only signals "you're behind, refetch", not "rejected".

import type { Classification, Folder, FolderSort, Item, ListState, Unit } from "./types";
import { UNITS } from "./types";

// updateItem's patch: Partial<Item> plus `catalogItemId: null` as an explicit
// "unlink" — a free rename turns a linked item into a custom one, and the old
// product's link must not survive the rename (it would keep feeding the
// weight-drift nudge from a product the user no longer has).
// folderId is excluded: moveItem is the SOLE folder-changing op — it validates the
// target folder against the list and keeps nested children's folderId in sync,
// neither of which a bare field patch can do (cleanItemPatch can't see the list).
export type ItemPatch = Omit<Partial<Item>, "catalogItemId" | "folderId"> & {
  catalogItemId?: number | null;
};

export type Op =
  | { t: "addItem"; item: Item }
  | { t: "updateItem"; id: string; patch: ItemPatch }
  | { t: "removeItem"; id: string }
  // moveItem reorders + reparents in one op. parentId: undefined = leave nesting as-is
  // (a plain reorder); null = top-level; a string = nest under that item.
  | { t: "moveItem"; id: string; folderId: string | null; sortOrder: number; parentId?: string | null }
  | { t: "addFolder"; folder: Folder }
  | { t: "updateFolder"; id: string; patch: Partial<Folder> }
  | { t: "removeFolder"; id: string }
  | { t: "setMeta"; patch: Partial<{ title: string; description: string; displayUnit: Unit }> };

const CLASSES: Classification[] = ["base", "worn", "consumable"];
// The non-default folder sorts. "manual" is the default and stored as ABSENT (see
// cleanFolderPatch/normalizeFolder), so it isn't in this set — an incoming "manual"
// (or any unknown value) clears sortBy back to the default rather than persisting it.
const FOLDER_SORTS: FolderSort[] = ["name", "heaviest", "lightest"];

// Hard caps (enforced in the reducer → client + server agree). Generous for
// real lists, but bound row size / DoS and keep summed totals exact under the
// bigint(mode:number) columns (MAX_ITEMS × qtyMax × UNIT_WEIGHT_MAX_MG < 2^53).
export const MAX_ITEMS = 1000;
export const MAX_FOLDERS = 50;
export const UNIT_WEIGHT_MAX_MG = 100_000_000; // 100 kg per single unit

// Identity strings are clamped too. Every HUMAN field below is length-capped, but
// item/folder ids + folderId references are free-form client strings — left
// unbounded, a hostile client could pack a single `data` JSONB row to hundreds of
// MB (1000 items × a giant id), amplified ×5 by the full-copy snapshots. 128 is far
// above any real uid().
const MAX_ID_LEN = 128;
// colorKey is interpolated into a CSS value (categoryColor → `var(--cat-<key>)`);
// restrict it to a safe charset so it can't smuggle a CSS token (e.g. a `url()`
// tracking beacon) onto a shared list a viewer opens.
const SAFE_COLOR_KEY = /^[a-z0-9-]{1,40}$/;

const clampWeight = (n: number) =>
  Math.max(0, Math.min(UNIT_WEIGHT_MAX_MG, Math.round(n)));

// Defensive clamps so a malformed op (or hostile client) can't corrupt state.
function cleanItemPatch(patch: ItemPatch): Partial<Item> {
  const out: Partial<Item> = {};
  if (typeof patch.name === "string") out.name = patch.name.slice(0, 200);
  // brand/variant: a non-empty string sets it; "" clears it (so a free rename can
  // drop the catalog-derived brand/variant from a now-custom item)
  if (typeof patch.brand === "string") out.brand = patch.brand ? patch.brand.slice(0, 120) : undefined;
  if (typeof patch.variant === "string") out.variant = patch.variant ? patch.variant.slice(0, 120) : undefined;
  // common name: a non-empty string sets it; "" clears it (mirrors brand/variant)
  if (typeof patch.commonName === "string") out.commonName = patch.commonName ? patch.commonName.slice(0, 120) : undefined;
  if (typeof patch.nameOverridden === "boolean") out.nameOverridden = patch.nameOverridden;
  if (typeof patch.description === "string") out.description = patch.description.slice(0, 2000);
  if (typeof patch.productUrl === "string") out.productUrl = patch.productUrl.slice(0, 2000);
  if (typeof patch.unitWeightMg === "number" && isFinite(patch.unitWeightMg))
    out.unitWeightMg = clampWeight(patch.unitWeightMg);
  if (typeof patch.qty === "number" && isFinite(patch.qty))
    out.qty = Math.max(0, Math.min(9999, Math.round(patch.qty)));
  if (typeof patch.wornQty === "number" && isFinite(patch.wornQty)) {
    const wq = Math.round(patch.wornQty);
    out.wornQty = wq > 0 ? Math.min(9999, wq) : undefined; // ≤0 clears the split
  }
  if (patch.classification === null || (typeof patch.classification === "string" && CLASSES.includes(patch.classification)))
    out.classification = patch.classification;
  // an explicit worn/consumable classification makes the split meaningless —
  // clear it in the same patch (wins over any wornQty also present)
  if (out.classification === "worn" || out.classification === "consumable")
    out.wornQty = undefined;
  if (typeof patch.weightOverridden === "boolean") out.weightOverridden = patch.weightOverridden;
  // catalog link fields — a number re-links (rename to a catalog pick, or the
  // nudge re-baselining to the current weight); null UNLINKS both fields (free
  // rename → now a custom item, the old product's link must not survive)
  if (patch.catalogItemId === null) {
    out.catalogItemId = undefined;
    out.catalogWeightMgAtLink = undefined;
  } else if (typeof patch.catalogItemId === "number" && isFinite(patch.catalogItemId))
    out.catalogItemId = patch.catalogItemId;
  if (patch.catalogItemId !== null && typeof patch.catalogWeightMgAtLink === "number" && isFinite(patch.catalogWeightMgAtLink))
    out.catalogWeightMgAtLink = clampWeight(patch.catalogWeightMgAtLink);
  if (typeof patch.packed === "boolean") out.packed = patch.packed;
  if (typeof patch.sortOrder === "number" && isFinite(patch.sortOrder)) out.sortOrder = patch.sortOrder;
  // no folderId branch: a raw op smuggling one in is ignored (see ItemPatch)
  return out;
}

function cleanFolderPatch(patch: Partial<Folder>): Partial<Folder> {
  const out: Partial<Folder> = {};
  if (typeof patch.name === "string") out.name = patch.name.slice(0, 120);
  if (typeof patch.colorKey === "string" && SAFE_COLOR_KEY.test(patch.colorKey)) out.colorKey = patch.colorKey;
  if (typeof patch.defaultClassification === "string" && CLASSES.includes(patch.defaultClassification))
    out.defaultClassification = patch.defaultClassification;
  // sortBy: a known non-default sort sets it; "manual" or anything unrecognized clears
  // it back to the default (undefined) — so switching a folder back to Manual removes
  // the field (dropped by JSON.stringify) instead of persisting a redundant "manual".
  if (typeof patch.sortBy === "string")
    out.sortBy = FOLDER_SORTS.includes(patch.sortBy as FolderSort) ? (patch.sortBy as FolderSort) : undefined;
  if (typeof patch.sortOrder === "number" && isFinite(patch.sortOrder)) out.sortOrder = patch.sortOrder;
  return out;
}

/** Apply a single op in place. Unknown/invalid ops are ignored (no throw). */
function applyOp(state: ListState, op: Op): void {
  switch (op?.t) {
    case "addItem":
      if (
        op.item &&
        typeof op.item.id === "string" &&
        state.items.length < MAX_ITEMS &&
        !state.items.some((i) => i.id === op.item.id)
      ) {
        const it = normalizeItem(op.item);
        // coerce a dangling folderId (e.g. folder deleted by a concurrent editor) to null
        if (it.folderId && !state.folders.some((f) => f.id === it.folderId)) it.folderId = null;
        // a valid child inherits its parent's folder; a dangling/non-top-level/self
        // parent coerces to top-level (keeps nesting one level deep + acyclic)
        if (it.parentId) {
          const parent = state.items.find((p) => p.id === it.parentId);
          if (parent && parent.parentId == null && parent.id !== it.id) it.folderId = parent.folderId;
          else it.parentId = null;
        }
        state.items.push(it);
      }
      break;
    case "updateItem": {
      const it = state.items.find((i) => i.id === op.id);
      if (it) {
        Object.assign(it, cleanItemPatch(op.patch || {}));
        // Normalize the worn/base split after ANY patch (needs the item's current
        // qty + classification, which cleanItemPatch can't see). A split only reads
        // as a GENUINE PARTIAL of a base line with ≥2 units, so:
        //  • the item is already explicitly worn/consumable → no base remainder to
        //    split: drop it (mirrors normalizeItem; a wornQty-only patch must not
        //    resurrect a split — or flip a consumable to Worn via the collapse below)
        //  • qty < 2 → nothing to split: drop it, let the item's base class stand
        //    (not clamp to 1, which would flip the lone unit to fully worn)
        //  • every copy worn (wornQty ≥ qty) → that's just the Worn class, not a
        //    "N worn · 0 base" split with no base remainder
        //  • otherwise a real partial (1 ≤ wornQty ≤ qty−1) stays as-is
        if (it.wornQty != null) {
          if (it.classification === "worn" || it.classification === "consumable") {
            it.wornQty = undefined;
          } else if (it.qty < 2) {
            it.wornQty = undefined;
          } else if (it.wornQty >= it.qty) {
            it.classification = "worn";
            it.wornQty = undefined;
          }
        }
      }
      break;
    }
    case "removeItem":
      // removing a parent takes its nested children with it (they can't outlive it)
      state.items = state.items.filter((i) => i.id !== op.id && i.parentId !== op.id);
      break;
    case "moveItem": {
      const it = state.items.find((i) => i.id === op.id);
      if (it) {
        // reparent (only when the op carries a parentId; undefined = leave as-is). A
        // valid parent must exist, be top-level, differ from this item, and this item
        // must not itself have children — keeping nesting one level deep + acyclic.
        if (op.parentId !== undefined) {
          let parentId: string | null = null;
          if (typeof op.parentId === "string" && op.parentId !== op.id) {
            const parent = state.items.find((p) => p.id === op.parentId);
            const hasKids = state.items.some((c) => c.parentId === op.id);
            if (parent && parent.parentId == null && !hasKids) parentId = op.parentId;
          }
          it.parentId = parentId;
        }
        // a child always follows its parent's folder; otherwise honor the op's folder
        const parent = it.parentId ? state.items.find((p) => p.id === it.parentId) : null;
        if (parent) it.folderId = parent.folderId;
        else if (op.folderId === null) it.folderId = null;
        else if (typeof op.folderId === "string")
          it.folderId = state.folders.some((f) => f.id === op.folderId) ? op.folderId : null;
        if (typeof op.sortOrder === "number") it.sortOrder = op.sortOrder;
        // nested children carry their parent's folderId (types.ts) — cascade so a
        // parent crossing folders takes its children along. A no-op for every other
        // flavor: reorders keep the same folder, and a newly-nested item is
        // childless per the hasKids guard above.
        for (const c of state.items) if (c.parentId === it.id) c.folderId = it.folderId;
      }
      break;
    }
    case "addFolder":
      if (
        op.folder &&
        typeof op.folder.id === "string" &&
        state.folders.length < MAX_FOLDERS &&
        !state.folders.some((f) => f.id === op.folder.id)
      )
        state.folders.push(normalizeFolder(op.folder));
      break;
    case "updateFolder": {
      const f = state.folders.find((x) => x.id === op.id);
      if (f) Object.assign(f, cleanFolderPatch(op.patch || {}));
      break;
    }
    case "removeFolder":
      state.folders = state.folders.filter((f) => f.id !== op.id);
      state.items = state.items.filter((i) => i.folderId !== op.id);
      break;
    case "setMeta": {
      const p = op.patch || {};
      if (typeof p.title === "string") state.title = p.title.slice(0, 200);
      if (typeof p.description === "string") state.description = p.description.slice(0, 4000);
      if (typeof p.displayUnit === "string" && UNITS.includes(p.displayUnit)) state.displayUnit = p.displayUnit;
      break;
    }
  }
}

export function applyOps(state: ListState, ops: Op[]): ListState {
  for (const op of ops) applyOp(state, op);
  return state;
}

export function normalizeItem(raw: Item): Item {
  const qty = Math.max(0, Math.min(9999, Math.round(Number(raw.qty) || 1)));
  let classification = CLASSES.includes(raw.classification as Classification)
    ? (raw.classification as Classification)
    : null;
  const wornQtyRaw =
    typeof raw.wornQty === "number" && isFinite(raw.wornQty) ? Math.round(raw.wornQty) : 0;
  // Resolve the worn split exactly as the op-reducer does: keep it only as a genuine
  // partial of a base-effective line with ≥2 units; an all-worn count is just the
  // Worn class, and a lone line has nothing to split.
  let wornQty: number | undefined;
  if (wornQtyRaw > 0 && qty >= 2 && classification !== "worn" && classification !== "consumable") {
    if (wornQtyRaw < qty) wornQty = wornQtyRaw;
    else classification = "worn";
  }
  return {
    id: String(raw.id).slice(0, MAX_ID_LEN),
    // empty string collapses to null — a real id or nothing. "" is a truthy-looking
    // non-id that would dodge the dangling-ref heals (both are `if (folderId && …)`)
    // AND the strict `=== null` ungrouped predicate, leaving the item rendered in no
    // folder yet counted in totals: invisible, UI-undeletable weight.
    folderId: typeof raw.folderId === "string" && raw.folderId ? raw.folderId.slice(0, MAX_ID_LEN) : null,
    // the item this is nested under (validated against real, top-level items by the
    // addItem/moveItem reducer cases, which can see the whole list; here we only clamp)
    parentId: typeof raw.parentId === "string" && raw.parentId ? raw.parentId.slice(0, MAX_ID_LEN) : null,
    name: String(raw.name ?? "").slice(0, 200),
    brand: raw.brand ? String(raw.brand).slice(0, 120) : undefined,
    variant: raw.variant ? String(raw.variant).slice(0, 120) : undefined,
    commonName: raw.commonName ? String(raw.commonName).slice(0, 120) : undefined,
    nameOverridden: raw.nameOverridden ? true : undefined,
    unitWeightMg: clampWeight(Number(raw.unitWeightMg) || 0),
    weightOverridden: !!raw.weightOverridden,
    qty,
    wornQty,
    classification,
    description: raw.description ? String(raw.description).slice(0, 2000) : undefined,
    productUrl: raw.productUrl ? String(raw.productUrl).slice(0, 2000) : undefined,
    imageUrl: raw.imageUrl ? String(raw.imageUrl).slice(0, 2000) : undefined,
    priceCents:
      typeof raw.priceCents === "number" && isFinite(raw.priceCents)
        ? Math.max(0, Math.round(raw.priceCents))
        : undefined,
    currency: raw.currency ? String(raw.currency).slice(0, 8) : undefined,
    catalogItemId:
      typeof raw.catalogItemId === "number" && isFinite(raw.catalogItemId)
        ? raw.catalogItemId
        : undefined,
    catalogWeightMgAtLink:
      typeof raw.catalogWeightMgAtLink === "number" && isFinite(raw.catalogWeightMgAtLink)
        ? clampWeight(raw.catalogWeightMgAtLink)
        : undefined,
    packed: !!raw.packed,
    sortOrder: Number(raw.sortOrder) || 0,
  };
}

export function normalizeFolder(raw: Folder): Folder {
  return {
    id: String(raw.id).slice(0, MAX_ID_LEN),
    name: String(raw.name ?? "").slice(0, 120) || "Folder",
    colorKey: raw.colorKey && SAFE_COLOR_KEY.test(String(raw.colorKey)) ? String(raw.colorKey) : "other",
    defaultClassification: CLASSES.includes(raw.defaultClassification)
      ? raw.defaultClassification
      : "base",
    // only a known non-default sort survives; absent/"manual"/unknown → undefined
    // (dropped by JSON.stringify), read back as the default manual order
    sortBy: FOLDER_SORTS.includes(raw.sortBy as FolderSort) ? (raw.sortBy as FolderSort) : undefined,
    sortOrder: Number(raw.sortOrder) || 0,
  };
}
