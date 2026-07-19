// Markdown export — pure string building, ~0 KB, no deps. Pastes cleanly into
// Apple Notes. Shared by the client (copy/download) and later the server.

import type { ListSnapshot } from "../types";
import { computeTotals, effectiveClassification, formatWeight, itemDisplayName, lineMg, rowDisplayMg, splitWornQty } from "../weights";
import { exportSections } from "./rows";

// a product name with its common name trailing after an em dash, when the item has one
const withCommon = (name: string, commonName?: string) =>
  commonName ? `${name} — ${commonName}` : name;

export function listToMarkdown(list: ListSnapshot): string {
  const u = list.displayUnit;
  const totals = computeTotals(list);
  const out: string[] = [];

  out.push(`# ${list.title || "Mahonia list"}`);
  out.push("");

  // exportSections carries the app's visible order (folders by sortOrder, then an
  // "Ungrouped" tail) so the table rows always sum to the totals block below —
  // ungrouped items are in computeTotals, so they must be in the tables too.
  for (const section of exportSections(list)) {
    if (!section.rows.length) continue;
    out.push(`## ${section.name}`);
    out.push("");
    out.push("| Item | Qty | Weight |");
    out.push("| --- | ---: | ---: |");
    for (const { item: it, children: kids } of section.rows) {
      // a group's weight is its total (own + children); a plain row shows its own
      // line — kids is already this row's children, so no whole-list rescan
      const rowMg = rowDisplayMg(it, kids);
      const w = rowMg > 0 ? formatWeight(rowMg, u) : "—";
      // the product name, with the common name trailing it after an em dash when set
      // ("Altra Lone Peak 9+ — Shoes") so a pasted list still says what each item is
      const name = withCommon(itemDisplayName(it.brand, it.name, it.variant), it.commonName);
      const wq = splitWornQty(it, effectiveClassification(it, list.folders));
      out.push(`| ${name} | ${it.qty}${wq > 0 ? ` (${wq} worn)` : ""} | ${w} |`);
      // nested items as indented sub-rows (the row weight above is their total)
      for (const child of kids) {
        const cw = child.unitWeightMg > 0 ? formatWeight(lineMg(child), u) : "—";
        const cn = withCommon(itemDisplayName(child.brand, child.name, child.variant), child.commonName);
        out.push(`| ↳ ${cn} | ${child.qty} | ${cw} |`);
      }
    }
    out.push("");
  }

  if (totals.hasWeights) {
    out.push("---");
    out.push("");
    out.push(`- **Base weight:** ${formatWeight(totals.baseMg, u)}`);
    out.push(`- **Worn:** ${formatWeight(totals.wornMg, u)}`);
    out.push(`- **Consumable:** ${formatWeight(totals.consumableMg, u)}`);
    out.push(`- **Total:** ${formatWeight(totals.totalMg, u)}`);
  }

  return out.join("\n");
}
