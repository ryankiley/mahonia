// My Gear onto the list, by the set: a kit — the gesture the gear pane offers that puts
// more than one row down at once.
//
// Beside the pane rather than in the controller, for the editor's first-load budget:
// the pane is the only surface that makes it, and the pane is a lazy chunk, so what
// only it calls belongs in its chunk. The controller keeps the primitive it leans on —
// addVaultItem, which the pane's row drag and the autocomplete's pick also reach.

import { listNormKeys, type VaultEntry } from "~~/shared/vault";

/** The slice of useGearList this composes. */
type Controller = Pick<ReturnType<typeof useGearList>, "snapshot" | "addVaultItem">;

/**
 * A kit onto the list — as a GROUP, never as one row.
 *
 * The kit's row is the group's parent: its name, filed where you asked, carrying the
 * kit's OWN weight (the stuff sack) the way a parent row keeps a weight of its own,
 * still counted. Each live part goes under it as a real row, at the count the kit
 * holds it, so for this trip you can drop the windscreen, hand the pot to someone
 * else or note something on the lighter — the whole reason a kit unfolds rather than
 * landing flat at its total.
 *
 * `gear` is the vault as the pane holds it: a part is only ever a few fields on the
 * kit (name, weight, count), and the row it becomes wants everything the piece knows —
 * its type, class, calories, catalog link — which is on the piece's own entry. A part
 * not in `gear` is put away, and a put-away part doesn't travel: it stopped counting
 * on /gear, and it stops here.
 *
 * A part the list already holds is skipped, the pane's one-row-per-piece rule — the
 * lighter already on the list is the lighter — so a kit can land with fewer rows than
 * it has parts, and the list says why by already showing the rest.
 */
export function addVaultKit(c: Controller, entry: VaultEntry, folderId: string | null, gear: readonly VaultEntry[]): string {
  if (!c.snapshot.value || entry.kind !== "kit") return "";
  const parentId = c.addVaultItem({ ...entry, weightMg: entry.ownWeightMg ?? 0 }, folderId);
  if (!parentId) return "";
  const held = listNormKeys(c.snapshot.value.items);
  const byId = new Map(gear.map((g) => [g.id, g]));
  for (const part of entry.parts ?? []) {
    if (part.removed) continue;
    const piece = byId.get(part.id);
    if (!piece || piece.kind === "kit" || held.has(piece.normKey)) continue;
    c.addVaultItem(piece, folderId, { parentId, qty: part.qty });
    held.add(piece.normKey);
  }
  return parentId;
}

