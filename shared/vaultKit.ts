// Kits — the arithmetic and the builder. The types, and the one gate a list row asks
// (isKitWorthy), live in shared/vault, which every row of the editor imports; this
// module is for the surfaces that load on a click (the gear page, its dialog, the
// group row's press, the pane) and for the server, so none of it rides on the
// editor's first load. See shared/vault for what a kit is.

import {
  gearFromItem,
  isVaultWorthy,
  isWaterRow,
  type VaultCapture,
  type VaultEntry,
  type VaultKitCapture,
  type VaultKitPart,
  type VaultKitPartRef,
} from "./vault";
import type { Item } from "./types";

/** Most parts one kit holds. A kit is a handful of rows; this bounds a hand-rolled
 *  write, not a use. */
export const VAULT_KIT_PARTS_MAX = 100;
/** Most of one part a kit holds ("×2 batteries") — the editor's steppers stop here. */
export const VAULT_KIT_QTY_MAX = 99;

/** A kit's weight: its own, plus each part that isn't put away, times its qty. */
export function kitWeightMg(ownWeightMg: number, parts: readonly VaultKitPart[]): number {
  return parts.reduce((sum, p) => (p.removed ? sum : sum + p.weightMg * p.qty), ownWeightMg);
}

/**
 * What a row adds to a FLAT total — a file's, where every piece is a line of its own.
 * Each piece counts once, where it is filed; a kit adds only its own weight, because
 * its parts are already counted as the lines they are.
 */
export function countedWeightMg(e: Pick<VaultEntry, "weightMg" | "kind" | "ownWeightMg">): number {
  return e.kind === "kit" ? (e.ownWeightMg ?? 0) : e.weightMg;
}

/**
 * A GROUP row offered to the vault as a KIT — the one way a container is gear.
 *
 * captureFromList stands by its rule: the automatic path captures a group's children
 * and never the group, because a capture runs on every pause and must not quietly
 * make a kit of every heading you nest things under. This is the deliberate act
 * instead — the group row's own Save to My Gear press — and it says: this set, as I
 * have it on this list, is a kit I own.
 *
 * The kit's weight is the parent's OWN (a row that already had a weight keeps it when
 * something nests under it, still counted — see useGearListNesting), which is the
 * stuff sack, usually nothing; the parts are the children capture would take on their
 * own, by identity, with the count each row carried. Two children of one identity are
 * one part with their counts added: a list that lists the lighter twice means two.
 * Null when there is nothing to make a kit of: a nameless parent, water, or no child
 * that is gear yet (a kit of blank rows is a heading, not a set) — the same answer
 * isKitWorthy gives the row before the press.
 */
export function kitFromGroup(
  parent: Item,
  children: readonly Item[],
  folderName?: string,
): { kit: VaultKitCapture; parts: VaultCapture[] } | null {
  if (isWaterRow(parent)) return null;
  // marked the way captureFromList marks a row: a catalog pick nobody renamed is kept
  // under the catalog's current spelling (the server's respell), like any capture
  const spelled = (item: Item) => item.catalogItemId != null && !item.nameOverridden;
  const base = gearFromItem(parent, folderName);
  if (!base) return null;
  const own = { ...base, catalogSpelling: spelled(parent) };
  const parts = new Map<string, VaultKitPartRef>();
  const captures = new Map<string, VaultCapture>();
  for (const child of children) {
    if (child.parentId !== parent.id || !isVaultWorthy(child, false)) continue;
    const found = gearFromItem(child, folderName);
    if (!found || found.normKey === own.normKey) continue;
    const cap = { ...found, catalogSpelling: spelled(child) };
    captures.set(cap.normKey, cap);
    const qty = Math.max(1, Math.round(child.qty) || 1);
    const have = parts.get(cap.normKey);
    if (have) have.qty = Math.min(VAULT_KIT_QTY_MAX, have.qty + qty);
    else parts.set(cap.normKey, { normKey: cap.normKey, qty: Math.min(VAULT_KIT_QTY_MAX, qty) });
  }
  if (!parts.size) return null;
  return {
    kit: { ...own, parts: [...parts.values()].slice(0, VAULT_KIT_PARTS_MAX) },
    parts: [...captures.values()].slice(0, VAULT_KIT_PARTS_MAX),
  };
}
