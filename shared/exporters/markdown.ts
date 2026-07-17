// Markdown export — pure string building, ~0 KB, no deps. Pastes cleanly into
// Apple Notes. Shared by the client (copy/download) and later the server.

import type { ListSnapshot } from "../types";
import { childrenOf, computeTotals, effectiveClassification, formatWeight, groupLineMg, itemDisplayName, lineMg, sortedFolderItems, splitWornQty } from "../weights";

export function listToMarkdown(list: ListSnapshot): string {
  const u = list.displayUnit;
  const totals = computeTotals(list);
  const out: string[] = [];

  out.push(`# ${list.title || "Mahonia list"}`);
  out.push("");

  for (const folder of list.folders) {
    const items = sortedFolderItems(list.items, folder);
    if (!items.length) continue;
    out.push(`## ${folder.name}`);
    out.push("");
    out.push("| Item | Qty | Weight |");
    out.push("| --- | ---: | ---: |");
    for (const it of items) {
      const kids = childrenOf(list.items, it.id);
      // a group's weight is its total (own + children); a plain row shows its own line
      const rowMg = kids.length ? groupLineMg(it, list.items) : lineMg(it);
      const w = rowMg > 0 ? formatWeight(rowMg, u) : "—";
      const name = itemDisplayName(it.brand, it.name, it.variant);
      const wq = splitWornQty(it, effectiveClassification(it, list.folders));
      out.push(`| ${name} | ${it.qty}${wq > 0 ? ` (${wq} worn)` : ""} | ${w} |`);
      // nested items as indented sub-rows (the row weight above is their total)
      for (const child of kids) {
        const cw = child.unitWeightMg > 0 ? formatWeight(lineMg(child), u) : "—";
        out.push(`| ↳ ${itemDisplayName(child.brand, child.name, child.variant)} | ${child.qty} | ${cw} |`);
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
