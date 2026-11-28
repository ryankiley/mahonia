// Markdown export — pure string building, ~0 KB, no deps. Pastes cleanly into
// Apple Notes. Shared by the client (copy/download) and by the server, which serves
// the same text at /s/{code}.md (server/middleware/shareMarkdown.ts) — a test pins
// the two byte-for-byte, so a change here is a change to what a share link reads as.

import type { Item, ListSnapshot } from "../types";
import { carrierName, effectivePersonId } from "../people";
import { carriedIsDistinct, computeTotals, effectiveClassification, formatKcal, formatWeight, isBareGroup, itemDisplayName, lineMg, groupLineMg, splitWornQty } from "../weights";
import { exportSections, gearTypeBeside } from "./rows";
import { isWaterName, waterVolumeLabel } from "../water";
import { dropHidden } from "../tidyText";
import { parseIsoDate } from "../calendar";
import { formatDistance, resolveDistanceUnit } from "../trailDistance";
import { CANONICAL_ORIGIN } from "../site";

// The name, then what the read view's sub-line says under it: the gear type after an em
// dash when it adds something (gearTypeBeside: no "Toothpaste — Toothpaste"), then the
// owner's note in italics, after a dot as on screen ("Monday — *Meals*", "Water —
// Hydration · *Drinking water*"). The note was dropped, and it is sometimes all that
// tells two rows apart: a five-day list's "Monday" for meals and "Monday" for snacks.
// markdownImport.ts reads these parts back in this order.
//
// Each part is escaped on its own (cell, below) and the result is the cell as written:
// escaping the whole would double the backslash of a note's escaped "*", which is the
// one character a note can hold that would end its italics early.
const withSubline = (name: string, commonName?: string, note?: string) => {
  const common = gearTypeBeside(name, commonName);
  const said = note?.trim() ? `*${cell(note.trim()).replace(/\*/g, "\\*")}*` : "";
  const sub = [common && cell(common), said].filter(Boolean).join(" · ");
  return sub ? `${cell(name)} — ${sub}` : cell(name);
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The trip's dates, the year always said: a pasted list outlives the year it was
 *  written in, and this text is the same whoever reads it, whenever (the share page's
 *  relative "Tomorrow" is a reader's-clock nicety this can't have). */
function tripDates(start?: string, end?: string): string {
  // parseIsoDate gives the calendar day as a LOCAL date, so its parts are the stored
  // ones in any timezone (shared/calendar.ts says why new Date(iso) isn't)
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  const day = (d: Date, year: boolean) => `${MONTHS[d.getMonth()]} ${d.getDate()}${year ? `, ${d.getFullYear()}` : ""}`;
  if (!a || !b) return a || b ? day((a ?? b)!, true) : "";
  if (a.getFullYear() !== b.getFullYear()) return `${day(a, true)} – ${day(b, true)}`;
  if (a.getMonth() !== b.getMonth()) return `${day(a, false)} – ${day(b, true)}`;
  return a.getDate() === b.getDate() ? day(a, true) : `${MONTHS[a.getMonth()]} ${a.getDate()}–${b.getDate()}, ${a.getFullYear()}`;
}

// the carrier in trailing italics, when there is one — a peopleless list (every
// list before the feature) produces byte-identical output to what it always did
const withCarrier = (escaped: string, carrier?: string) =>
  carrier ? `${escaped} *(${cell(carrier)})*` : escaped;

// The Item cell, with the three characters a name can carry that a renderer would
// not show as written escaped the way GFM reads them (a backslash). A pipe BREAKS the
// table rather than styling its text: "Socks | 3 pr" would end the cell at the bar
// and put its own weight a column to the right. A backslash is the escape itself, so
// it is doubled first, or a name already holding "\|" would come out as an escaped
// backslash and a live pipe. And "<" before a letter (or !, / or ?) opens an inline
// HTML tag, the one Markdown construct that DELETES text: "Tarp <spare>" renders as
// "Tarp" on GitHub and shows an empty unknown element everywhere else, where "<20F"
// is no tag and stays. Other Markdown in a name (*stars*, an underscore) reads as
// Markdown, which a reader can see. Only the Item cell needs it: the rest are numbers.
const cell = (text: string) => text.replace(/[\\|]|<(?=[A-Za-z!/?])/g, "\\$&");

/** The count cell is shared by top-level and nested rows, including a base-row worn split.
 *  Water's is its volume: it has no count (waterVolumeLabel). */
function quantityLabel(item: Item, folders: ListSnapshot["folders"]): string {
  if (isWaterName(item.name)) return waterVolumeLabel(item);
  const wornQty = splitWornQty(item, effectiveClassification(item, folders));
  return `${item.qty}${wornQty > 0 ? ` (${wornQty} worn)` : ""}`;
}

/** The two lines that open every folder's table. Exported for the MCP tool, which
 *  reads the text back line by line to cut it to size (server/utils/mcp fitMarkdown). */
export const MD_HEADER = "| Item | Qty | Weight |";
export const MD_RULE = "| --- | ---: | ---: |";

export function listToMarkdown(list: ListSnapshot): string {
  const u = list.displayUnit;
  const totals = computeTotals(list);
  const out: string[] = [];

  out.push(`# ${list.title || "Mahonia list"}`);
  out.push("");
  // What the share page says above the list and a pasted table didn't: the trail, the
  // dates, how far. The distance in the unit the list reads it in, as the share page
  // shows it (ReadonlyListView's distanceUnit): the owner's pick, else miles.
  const facts = [
    list.trailLabel?.trim(),
    tripDates(list.startDate, list.endDate),
    list.trailDistanceM ? formatDistance(list.trailDistanceM, resolveDistanceUnit(list.trailDistanceUnit)) : "",
  ].filter(Boolean);
  if (facts.length) out.push(facts.join(" · "), "");
  // and where the rest lives: the plain-text copy always carried its link, this didn't.
  // Built from the share code, the READ-ONLY address (an edit token is never in a
  // snapshot), so the copy and /s/{code}.md say the same thing.
  if (list.shareCode) out.push(`${CANONICAL_ORIGIN}/s/${list.shareCode}`, "");

  // exportSections carries the app's visible order (folders by sortOrder, then an
  // "Unfiled" tail) so the table rows always sum to the totals block below —
  // ungrouped items are in computeTotals, so they must be in the tables too.
  for (const section of exportSections(list)) {
    if (!section.rows.length) continue;
    out.push(`## ${section.name}`);
    out.push("");
    out.push(MD_HEADER);
    out.push(MD_RULE);
    for (const { item: it, children: kids } of section.rows) {
      // a group's weight is its total (own + children); a plain row shows its own
      // line — kids is already this row's children, so no whole-list rescan
      const rowMg = groupLineMg(it, kids);
      // in the unit the row reads in on screen (ReadonlyItemRow's rowUnit): a risotto
      // typed as 7.5 oz on a pounds list is 7.5 oz here, not 0.47 lb. A group's
      // entryUnit is the unit its owner picked for the total, the same double duty.
      const w = rowMg > 0 ? formatWeight(rowMg, it.entryUnit ?? u) : "—";
      // the product name, with the common name trailing it after an em dash when set
      // ("Altra Lone Peak 9+ — Trail runners") so a pasted list still says what each item is
      const name = withCarrier(
        withSubline(itemDisplayName(it.brand, it.name, it.variant), it.commonName, it.description),
        carrierName(list, it),
      );
      // a bare group's Qty cell is empty, matching the three on-screen faces: the weight
      // beside it is the GROUP total, so a count there multiplies a figure it is already
      // inside — and on a row whose own line is zero, it multiplies zero
      const qty = isBareGroup(it, kids.length > 0) ? "" : quantityLabel(it, list.folders);
      out.push(`| ${name} | ${qty} | ${w} |`);
      // nested items as indented sub-rows (the row weight above is their total)
      for (const child of kids) {
        const cw = child.unitWeightMg > 0 ? formatWeight(lineMg(child), child.entryUnit ?? u) : "—";
        // a child names its carrier only when it DIFFERS from the parent's — every
        // sub-row repeating the name above it would be noise, not information.
        // Compared by ID: names are unique per list now, but a list written before
        // that rule can still hold two, and comparing the strings would silently
        // un-name a child carried by the OTHER one.
        const cn = withCarrier(
          withSubline(itemDisplayName(child.brand, child.name, child.variant), child.commonName, child.description),
          effectivePersonId(child, it) === effectivePersonId(it) ? undefined : carrierName(list, child, it),
        );
        out.push(`| ↳ ${cn} | ${quantityLabel(child, list.folders)} | ${cw} |`);
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
  // the calories the totals bar shows, under the same name; the food rows' own figures
  // stay on the share page, where they sit beside their weights
  if (totals.hasKcal && totals.kcalTotal > 0) {
    if (!totals.hasWeights) out.push("---", "");
    out.push(`- **Calories:** ${formatKcal(totals.kcalTotal)} kcal`);
  }

  // the read a model gets when it fetches a share link, so nothing in it may be hidden
  // from the person who shared it: tidyText's rule for stored text, kept at the door too
  return dropHidden(out.join("\n"));
}
