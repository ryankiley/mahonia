// A read-only link to someone's My Gear: /g/{code}. What the person who holds the link
// sees, decided here once, as a pure function of the owner's own read.
//
// Decided with Ryan, 2026-11-27: the Gear and Kits tabs, never Food (consumables change
// trip to trip and say little about the kit); never a price; the owner's account name
// when they have set one, and nothing about them otherwise; and the link stops working
// the moment it is turned off (the read is never cached: server/api/g/[code].get.ts).
//
// FAIL-CLOSED, the way a list's public snapshot is (listRepo's rowToSnapshot): each
// piece is BUILT from the fields allowed out, never copied and pruned, so a field added
// to VaultEntry later stays private until someone decides it may leave. Ids are the
// vault's serial row ids, so they are renumbered (1, 2, 3 in the order read) and every
// reference between pieces (a kit's parts, a piece's kits) follows the new numbers.

import type { VaultEntry, VaultKitPart } from "./vault";
import { vaultTabOf } from "./vaultView";

/** What a shared page receives: the owner's chosen name, when they have one, and the
 *  pieces and kits, each shaped as a VaultEntry so the page draws them with My Gear's own
 *  rows. The fields a VaultEntry requires but a viewer has no business with (normKey,
 *  timesSeen, the dates) are present and empty. */
export interface SharedGear {
  owner?: string;
  items: VaultEntry[];
}

export function sharedGear(
  entries: readonly VaultEntry[],
  owner: string | null | undefined,
): SharedGear {
  const shown = entries.filter((e) => vaultTabOf(e) !== "food");
  const renumber = new Map<number, number>();
  shown.forEach((e, i) => renumber.set(e.id, i + 1));
  // a kit's part keeps its place in the kit even when the piece itself is off the page
  // (a bar in the snack kit): the part carries its own name and weight, so it needs a
  // number of its own that no shown piece has
  let next = shown.length;
  const partId = (id: number) =>
    renumber.get(id) ?? (renumber.set(id, ++next), next);

  const items = shown.map((e): VaultEntry => {
    const out: VaultEntry = {
      id: renumber.get(e.id)!,
      normKey: "",
      name: e.name,
      weightMg: e.weightMg,
      timesSeen: 0,
      lastUsedAt: "",
      createdAt: "",
    };
    if (e.brand) out.brand = e.brand;
    if (e.variant) out.variant = e.variant;
    if (e.commonName) out.commonName = e.commonName;
    if (e.icon) out.icon = e.icon;
    if (e.entryUnit) out.entryUnit = e.entryUnit;
    if (e.owned) out.owned = e.owned;
    if (e.classification) out.classification = e.classification;
    if (e.specs) out.specs = e.specs;
    if (e.kind === "kit") {
      out.kind = "kit";
      out.ownWeightMg = e.ownWeightMg ?? 0;
      out.parts = (e.parts ?? []).map((p): VaultKitPart => {
        const part: VaultKitPart = {
          id: partId(p.id),
          qty: p.qty,
          name: p.name,
          weightMg: p.weightMg,
        };
        if (p.brand) part.brand = p.brand;
        if (p.variant) part.variant = p.variant;
        if (p.removed) part.removed = true;
        return part;
      });
    }
    const kits = (e.inKits ?? []).flatMap((k) =>
      renumber.has(k) ? [renumber.get(k)!] : [],
    );
    if (kits.length) out.inKits = kits;
    return out;
  });
  const name = owner?.trim();
  return name ? { owner: name, items } : { items };
}
