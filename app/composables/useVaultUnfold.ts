// My Gear onto the list, by the set: a whole category, and a kit — the two gestures
// the gear pane offers that put more than one row down at once.
//
// Beside the pane rather than in the controller, for the editor's first-load budget:
// the pane is the only surface that makes either gesture, and the pane is a lazy
// chunk, so what only it calls belongs in its chunk. The controller keeps the one
// primitive both lean on — addVaultItem, which the pane's row drag and the
// autocomplete's pick also reach — and these compose it.

import type { VaultEntry } from "~~/shared/vault";
import { vaultNormKey } from "~~/shared/vault";

/** The slice of useGearList these two compose. */
type Controller = Pick<ReturnType<typeof useGearList>, "snapshot" | "addVaultItem" | "addFolder">;

/** What the open list already holds, by the vault's identity rule — the one-row-per-
 *  piece rule both gestures keep. */
function heldKeys(c: Controller): Set<string> {
  return new Set(
    (c.snapshot.value?.items ?? []).map((i) => vaultNormKey(i.brand, i.name, i.variant)).filter(Boolean),
  );
}

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
  const held = heldKeys(c);
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

/**
 * Clone a whole vault folder into the list — a category template.
 *
 * The vault already files gear by the NAME of the list folder it came from, so a
 * "Kitchen" you built once is already a set; this is the missing direction, which is
 * getting the set back out. Reuses the controller's addFolder + addVaultItem rather
 * than building items here, so the naming/colour rules and the pinned-override rules
 * each stay in one place.
 *
 * Gear the list already holds is skipped, matching the pane's per-row rule: wanting
 * two of something is a quantity, and a second identical row would split one thing's
 * weight across two lines. A KIT in the category comes in as a group with its parts
 * under it — so a piece filed here that is one of those parts arrives INSIDE the kit,
 * not as a flat row beside it, which would be the same gear twice.
 *
 * Returns the new folder's id, or "" if there was nothing to add — the caller
 * shouldn't be left with an empty folder it didn't ask for.
 */
export function addVaultFolder(c: Controller, name: string, entries: VaultEntry[]): string {
  const snap = c.snapshot.value;
  if (!snap || !entries.length) return "";
  const held = heldKeys(c);
  const kits = entries.filter((e) => e.kind === "kit" && !held.has(e.normKey));
  const inside = new Set(kits.flatMap((k) => (k.parts ?? []).filter((p) => !p.removed).map((p) => p.id)));
  const fresh = entries.filter((e) => e.kind !== "kit" && !held.has(e.normKey) && !inside.has(e.id));
  if (!fresh.length && !kits.length) return "";

  // the controller's own addFolder, so the naming and colour rules stay in one place
  const id = c.addFolder(name);
  for (const entry of entries) {
    if (entry.kind === "kit") {
      if (kits.includes(entry)) addVaultKit(c, entry, id, entries);
    } else if (fresh.includes(entry)) {
      c.addVaultItem(entry, id);
    }
  }
  return id;
}
