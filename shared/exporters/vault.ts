// My Gear, out — the two files behind /gear's Export menu.
//
// The vault is the one thing in Mahonia an account holds rather than a link, which
// makes it the one thing you can't already take with you by copying a URL. A list
// exports four ways; until now the gear it fills itself from exported no ways, and
// the only account-level data operation was delete.
//
// CSV is the interoperable one: its headers are deliberately the ones
// csvToListData already reads, so a gear export can be imported straight back as a
// list — "everything I own" as a starting point — as well as opened in a
// spreadsheet or fed to another tool. JSON is the faithful one: every field the API
// returns, pins and use counts included.
//
// Both take the rows the PAGE holds. That is the live gear by construction — the
// API returns what "Remove" put away as its own array, and /gear hands only `items`
// here — which is the right answer for a file called my-gear: the removed list is a
// repair affordance behind a disclosure, not part of the kit you own.

import type { Unit } from "../types";
import type { VaultEntry, VaultFolder } from "../vault";
import { groupVaultRows } from "../vaultView";
import { fromMg, itemDisplayName } from "../weights";
import { csvCell } from "./csvCell";

/** What both exporters are handed: the page's live rows and its folders. */
export interface VaultExport {
  items: VaultEntry[];
  folders: VaultFolder[];
}

// Column names are csvToListData's own vocabulary wherever the two overlap
// ("Folder" and "Item Name" and "Gear Type" are all names it maps), so this file
// re-imports as a list. The four it doesn't know — Currency, Image URL, Times Used,
// Last Used — are APPENDED rather than woven in, matching the list exporter's rule:
// tooling that reads a column by position must not have it move under them.
const HEADER =
  "Folder,Item Name,Gear Type,Brand,Weight,Unit,Worn,Consumable,Price,URL,Note,Kcal,Currency,Image URL,Times Used,Last Used";

/**
 * The gear as a spreadsheet, in the order the page shows it.
 *
 * Ordering is groupVaultRows — the SAME traversal /gear renders from, so a folder's
 * chosen sort is what lands in the file and the export can't drift from the screen.
 * Empty folders are dropped: a heading with nothing under it is a fact about the
 * page, not about the gear.
 *
 * Every row exports in ONE unit, unlike a list's CSV: a vault row has no entryUnit
 * (a weight there is a fact about the gear, not about how one list types it), so
 * the unit is the page's and the column says so on every line.
 */
export function vaultToCsv({ items, folders }: VaultExport, unit: Unit): string {
  const out = [HEADER];
  for (const section of groupVaultRows(items, folders, { keepEmpty: false })) {
    for (const e of section.entries) {
      const w = e.weightMg > 0 ? +fromMg(e.weightMg, unit).toFixed(unit === "g" ? 0 : 3) : "";
      out.push(
        [
          csvCell(section.folder?.name ?? ""),
          // brand has its own column, so the name field carries model + variant —
          // the list exporter's split, so the two files read alike
          csvCell(itemDisplayName(null, e.name, e.variant)),
          csvCell(e.commonName ?? ""),
          csvCell(e.brand ?? ""),
          w,
          e.weightMg > 0 ? unit : "",
          e.classification === "worn" ? "1" : "",
          e.classification === "consumable" ? "1" : "",
          // the bare number, like the list's Price column: a spreadsheet wants to
          // add these up, and "$399.00" is text. The currency has its own column.
          e.priceCents != null ? (e.priceCents / 100).toFixed(2) : "",
          csvCell(e.productUrl ?? ""),
          csvCell(e.description ?? ""),
          // carried on every row that has one, unlike a list's: the vault stores
          // kcal for the food itself, and a row's class here is one field rather
          // than a folder default it might be inheriting
          e.kcal ?? "",
          csvCell(e.currency ?? ""),
          csvCell(e.imageUrl ?? ""),
          e.timesSeen,
          // the day, not the instant — this column answers "when did I last pack
          // this", and a spreadsheet reads a date where an ISO timestamp is text
          (e.lastUsedAt || "").slice(0, 10),
        ].join(","),
      );
    }
  }
  return out.join("\n");
}

/**
 * The gear as a backup: every field the API returns, in the API's own shape.
 *
 * Deliberately NOT re-derived into some export-only schema — a backup whose shape
 * differs from the wire is one more thing that can drift. Rows come back in the
 * page's order for the same reason the CSV does.
 */
export function vaultToJson({ items, folders }: VaultExport): string {
  const ordered = groupVaultRows(items, folders, { keepEmpty: false }).flatMap((s) => s.entries);
  return JSON.stringify({ folders, items: ordered }, null, 2);
}
