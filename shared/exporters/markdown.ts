// Markdown export — pure string building, ~0 KB, no deps. Pastes cleanly into
// Apple Notes. Shared by the client (copy/download) and by the server, which serves
// the same text at /s/{code}.md (server/middleware/shareMarkdown.ts) — a test pins
// the two byte-for-byte, so a change here is a change to what a share link reads as.

import type { ListSnapshot } from "../types";
import { carrierName, effectivePersonId } from "../people";
import { carriedIsDistinct, computeTotals, effectiveClassification, formatWeight, isBareGroup, itemDisplayName, lineMg, rowDisplayMg, splitWornQty } from "../weights";
import { exportSections } from "./rows";

// a product name with its common name trailing after an em dash, when the item has one
const withCommon = (name: string, commonName?: string) =>
  commonName ? `${name} — ${commonName}` : name;

// the carrier in trailing italics, when there is one — a peopleless list (every
// list before the feature) produces byte-identical output to what it always did
const withCarrier = (name: string, carrier?: string) =>
  carrier ? `${name} *(${carrier})*` : name;

// The Item cell, with its pipes escaped the way GFM reads them (a backslash). A pipe
// is the one character in a name that BREAKS the table rather than styling its text:
// "Socks | 3 pr" would end the cell at the bar and put its own weight a column to the
// right. Nothing else is escaped; a name that happens to hold Markdown reads as
// Markdown, which a renderer copes with and a reader can see, where a shifted column
// misreports the weight. Only the Item cell needs it: the other two are numbers.
const cell = (text: string) => text.replace(/\|/g, "\\|");

export function listToMarkdown(list: ListSnapshot): string {
  const u = list.displayUnit;
  const totals = computeTotals(list);
  const out: string[] = [];

  out.push(`# ${list.title || "Mahonia list"}`);
  out.push("");

  // exportSections carries the app's visible order (folders by sortOrder, then an
  // "Unfiled" tail) so the table rows always sum to the totals block below —
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
      // ("Altra Lone Peak 9+ — Trail runners") so a pasted list still says what each item is
      const name = withCarrier(
        withCommon(itemDisplayName(it.brand, it.name, it.variant), it.commonName),
        carrierName(list, it),
      );
      const wq = splitWornQty(it, effectiveClassification(it, list.folders));
      // a bare group's Qty cell is empty, matching the three on-screen faces: the weight
      // beside it is the GROUP total, so a count there multiplies a figure it is already
      // inside — and on a row whose own line is zero, it multiplies zero
      const qty = isBareGroup(it, kids.length > 0) ? "" : `${it.qty}${wq > 0 ? ` (${wq} worn)` : ""}`;
      out.push(`| ${cell(name)} | ${qty} | ${w} |`);
      // nested items as indented sub-rows (the row weight above is their total)
      for (const child of kids) {
        const cw = child.unitWeightMg > 0 ? formatWeight(lineMg(child), u) : "—";
        // a child names its carrier only when it DIFFERS from the parent's — every
        // sub-row repeating the name above it would be noise, not information.
        // Compared by ID: names are unique per list now, but a list written before
        // that rule can still hold two, and comparing the strings would silently
        // un-name a child carried by the OTHER one.
        const cn = withCarrier(
          withCommon(itemDisplayName(child.brand, child.name, child.variant), child.commonName),
          effectivePersonId(child, it) === effectivePersonId(it) ? undefined : carrierName(list, child, it),
        );
        out.push(`| ↳ ${cell(cn)} | ${child.qty} | ${cw} |`);
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
    // the base + consumable roll-up, on the same rule the summary bar uses
    if (carriedIsDistinct(totals)) {
      out.push(`- **Carried:** ${formatWeight(totals.carriedMg, u)}`);
    }
    out.push(`- **Total:** ${formatWeight(totals.totalMg, u)}`);
  }

  return out.join("\n");
}
