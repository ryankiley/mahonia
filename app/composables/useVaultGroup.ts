// The group half of useVault.captureOne: a GROUP row and its children, offered to My
// Gear as a KIT — the one way a container is gear, and the deliberate one.
//
// Its own module, loaded on the press, for the editor's first-load budget: the save
// button is on every row, but a group's press is one gesture on one row, and the
// request shape it builds (kitFromGroup, the kit's own answer) has no business in
// what every visitor downloads. The ordinary row's press stays in useVault.
//
// Same request as a piece's press, same deliberate-update rule (overwriteWeight),
// one more field: the group itself, with which of its children are its parts. The
// server answers with the parts that landed and the kit's own key (captureKit), which
// folds into the list's answer like any other — so the group's button stands down,
// and a duplicate of a part further down the list stops offering too.

import type { Folder, Item } from "~~/shared/types";
import { kitFromGroup, type VaultGearKey } from "~~/shared/vault";
import type { CaptureOneResult } from "./useVault";

type VaultFetch = <T>(url: string, opts: { method: "POST"; body: unknown }) => Promise<T>;

export async function captureGroup(
  vaultFetch: VaultFetch,
  item: Item,
  allItems: Item[],
  folders: Folder[],
): Promise<{ result: CaptureOneResult; landed: VaultGearKey[] }> {
  const nothing: VaultGearKey[] = [];
  const made = kitFromGroup(item, allItems, folders.find((f) => f.id === item.folderId)?.name);
  if (!made) return { result: "unworthy", landed: nothing };
  let res: { keys?: VaultGearKey[]; full?: boolean; kit?: string } | undefined;
  try {
    res = await vaultFetch<{ keys?: VaultGearKey[]; full?: boolean; kit?: string }>("/api/vault/capture", {
      method: "POST",
      body: { items: made.parts, kit: made.kit, overwriteWeight: true },
    });
  } catch {
    return { result: "failed", landed: nothing };
  }
  // the parts that landed are banked whatever became of the kit — their rows'
  // buttons may stand down even when the group's can't
  const landed = res?.keys ?? [];
  if (res?.kit === "saved") return { result: "saved", landed };
  if (res?.kit === "removed") return { result: "removed", landed };
  if (res?.kit === "nested") return { result: "nested", landed };
  if (res?.kit === "full") return { result: "full", landed };
  return { result: "unworthy", landed };
}
