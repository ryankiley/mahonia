// Mutation operations — the SINGLE source of truth for how a list changes.
// The same reducer runs on the client (optimistic) and the server
// (authoritative), so the two states can never drift. Ops are designed to
// MERGE: two editors adding different items both succeed with no conflict; the
// version counter only signals "you're behind, refetch", not "rejected".

import type { Classification, Folder, Item, ListState, Unit } from "./types";
import { UNITS } from "./types";

export type Op =
  | { t: "addItem"; item: Item }
  | { t: "updateItem"; id: string; patch: Partial<Item> }
  | { t: "removeItem"; id: string }
  | { t: "moveItem"; id: string; folderId: string | null; sortOrder: number }
  | { t: "addFolder"; folder: Folder }
  | { t: "updateFolder"; id: string; patch: Partial<Folder> }
  | { t: "removeFolder"; id: string }
  | { t: "setMeta"; patch: Partial<{ title: string; description: string; displayUnit: Unit }> };

const CLASSES: Classification[] = ["base", "worn", "consumable"];

// Hard caps (enforced in the reducer → client + server agree). Generous for
// real lists, but bound row size / DoS and keep summed totals exact under the
// bigint(mode:number) columns (MAX_ITEMS × qtyMax × UNIT_WEIGHT_MAX_MG < 2^53).
export const MAX_ITEMS = 1000;
export const MAX_FOLDERS = 50;
export const UNIT_WEIGHT_MAX_MG = 100_000_000; // 100 kg per single unit

const clampWeight = (n: number) =>
  Math.max(0, Math.min(UNIT_WEIGHT_MAX_MG, Math.round(n)));

// Defensive clamps so a malformed op (or hostile client) can't corrupt state.
function cleanItemPatch(patch: Partial<Item>): Partial<Item> {
  const out: Partial<Item> = {};
  if (typeof patch.name === "string") out.name = patch.name.slice(0, 200);
  if (typeof patch.brand === "string") out.brand = patch.brand.slice(0, 120);
  if (typeof patch.description === "string") out.description = patch.description.slice(0, 2000);
  if (typeof patch.productUrl === "string") out.productUrl = patch.productUrl.slice(0, 2000);
  if (typeof patch.unitWeightMg === "number" && isFinite(patch.unitWeightMg))
    out.unitWeightMg = clampWeight(patch.unitWeightMg);
  if (typeof patch.qty === "number" && isFinite(patch.qty))
    out.qty = Math.max(0, Math.min(9999, Math.round(patch.qty)));
  if (patch.classification === null || (typeof patch.classification === "string" && CLASSES.includes(patch.classification)))
    out.classification = patch.classification;
  if (typeof patch.weightOverridden === "boolean") out.weightOverridden = patch.weightOverridden;
  if (typeof patch.packed === "boolean") out.packed = patch.packed;
  if (typeof patch.sortOrder === "number" && isFinite(patch.sortOrder)) out.sortOrder = patch.sortOrder;
  if (typeof patch.folderId === "string" || patch.folderId === null) out.folderId = patch.folderId;
  return out;
}

function cleanFolderPatch(patch: Partial<Folder>): Partial<Folder> {
  const out: Partial<Folder> = {};
  if (typeof patch.name === "string") out.name = patch.name.slice(0, 120);
  if (typeof patch.colorKey === "string") out.colorKey = patch.colorKey.slice(0, 40);
  if (typeof patch.defaultClassification === "string" && CLASSES.includes(patch.defaultClassification))
    out.defaultClassification = patch.defaultClassification;
  if (typeof patch.sortOrder === "number" && isFinite(patch.sortOrder)) out.sortOrder = patch.sortOrder;
  return out;
}

/** Apply a single op in place. Unknown/invalid ops are ignored (no throw). */
export function applyOp(state: ListState, op: Op): void {
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
        state.items.push(it);
      }
      break;
    case "updateItem": {
      const it = state.items.find((i) => i.id === op.id);
      if (it) Object.assign(it, cleanItemPatch(op.patch || {}));
      break;
    }
    case "removeItem":
      state.items = state.items.filter((i) => i.id !== op.id);
      break;
    case "moveItem": {
      const it = state.items.find((i) => i.id === op.id);
      if (it) {
        if (op.folderId === null) it.folderId = null;
        else if (typeof op.folderId === "string")
          it.folderId = state.folders.some((f) => f.id === op.folderId) ? op.folderId : null;
        if (typeof op.sortOrder === "number") it.sortOrder = op.sortOrder;
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
  return {
    id: String(raw.id),
    folderId: typeof raw.folderId === "string" ? raw.folderId : null,
    name: String(raw.name ?? "").slice(0, 200),
    brand: raw.brand ? String(raw.brand).slice(0, 120) : undefined,
    unitWeightMg: clampWeight(Number(raw.unitWeightMg) || 0),
    weightOverridden: !!raw.weightOverridden,
    qty: Math.max(0, Math.min(9999, Math.round(Number(raw.qty) || 1))),
    classification: CLASSES.includes(raw.classification as Classification)
      ? (raw.classification as Classification)
      : null,
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
    id: String(raw.id),
    name: String(raw.name ?? "").slice(0, 120) || "Folder",
    colorKey: raw.colorKey ? String(raw.colorKey).slice(0, 40) : "other",
    defaultClassification: CLASSES.includes(raw.defaultClassification)
      ? raw.defaultClassification
      : "base",
    sortOrder: Number(raw.sortOrder) || 0,
  };
}
