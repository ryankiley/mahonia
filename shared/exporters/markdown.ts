// Markdown export — pure string building, ~0 KB, no deps. Pastes cleanly into
// Apple Notes. Shared by the client (copy/download) and later the server.

import type { ListSnapshot } from "../types";
import { bySortOrder, computeTotals, effectiveClassification, formatWeight, itemDisplayName, itemsInFolder, lineMg, splitWornQty } from "../weights";

export function listToMarkdown(list: ListSnapshot): string {
  const u = list.displayUnit;
  const totals = computeTotals(list);
  const out: string[] = [];

  out.push(`# ${list.title || "Mahonia list"}`);
  out.push("");

  for (const folder of list.folders) {
    const items = itemsInFolder(list.items, folder.id).sort(bySortOrder);
    if (!items.length) continue;
    out.push(`## ${folder.name}`);
    out.push("");
    out.push("| Item | Qty | Weight |");
    out.push("| --- | ---: | ---: |");
    for (const it of items) {
      const w = it.unitWeightMg > 0 ? formatWeight(lineMg(it), u) : "—";
      const name = itemDisplayName(it.brand, it.name, it.variant);
      const wq = splitWornQty(it, effectiveClassification(it, list.folders));
      out.push(`| ${name} | ${it.qty}${wq > 0 ? ` (${wq} worn)` : ""} | ${w} |`);
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
