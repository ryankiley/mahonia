// A Markdown table, back in — the import side of markdown.ts.
//
// The import dialog read anything that wasn't a LighterPack link or our JSON as a CSV,
// so our own "Copy as Markdown" pasted back in made a list of 140 rows named
// "| --- | ---: | ---: |" and "## Shelter & sleep". This turns a table written the
// GitHub way into the CSV the importer already reads, so every rule that one has
// (folders, counts, units, nesting) applies here unchanged.
//
// Two readings. Our own table (Item | Qty | Weight, markdown.ts's MD_HEADER) is read
// cell by cell back into what its writer put there: the gear type after the em dash,
// the note in italics after it, the carrier in "*(…)*", "↳" for a row inside a group,
// "2 (1 worn)" for a worn split. Any other table is read by its own header row, the
// way a CSV's is. Either way a "## heading" names the folder for the table under it.
//
// What a table can't give back: a row's class (worn and consumable are totals there,
// not marks on rows) and anything finer than the figure as shown ("0.29 lb"). The JSON
// download is the backup; this is for a list that only exists as a table.

import type { Unit } from "../types";
import { isWaterName } from "../water";
import { entryUnitFromInput, fromMg, parseWeightInput } from "../weights";
import { csvCell } from "./csvCell";

// a table's rule row: "| --- | ---: |", pipes at either end optional
const RULE = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;

/** A table row's cells, split at the pipes markdown.ts doesn't escape, unescaped. */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\([\\|<*])/g, "$1"));
}

interface Row {
  category: string;
  name: string;
  gearType: string;
  note: string;
  person: string;
  qty: number;
  wornQty: number;
  /** the Weight cell as milligrams: a LINE (qty × one), or a group's total */
  lineMg: number;
  unit: Unit | "";
  /** a group row with an empty Qty cell — markdown.ts's mark for a bare group */
  bare: boolean;
  children: Row[];
}

/** Our own Item cell: "↳ Name — Gear type · *note* *(Carrier)*", every part optional. */
function readItemCell(raw: string): Pick<Row, "name" | "gearType" | "note" | "person"> & { nested: boolean } {
  let text = raw;
  const nested = text.startsWith("↳");
  if (nested) text = text.slice(1).trim();
  let person = "";
  const carrier = /\s\*\(([^)]*)\)\*$/.exec(text);
  if (carrier) {
    person = carrier[1]!.trim();
    text = text.slice(0, carrier.index);
  }
  let gearType = "";
  let note = "";
  const dash = text.lastIndexOf(" — ");
  if (dash > 0) {
    for (const part of text.slice(dash + 3).split(" · ")) {
      const italic = /^\*(.+)\*$/.exec(part.trim());
      if (italic) note = italic[1]!.trim();
      else if (!gearType) gearType = part.trim();
    }
    text = text.slice(0, dash);
  }
  return { name: text.trim(), gearType, note, person, nested };
}

/** A weight cell as shown ("2.19 lb", "<1 g", "—") → milligrams and the unit it names. */
function readWeight(cell: string): { mg: number; unit: Unit | "" } {
  const text = cell.replace(/^</, "").trim();
  const mg = text && text !== "—" ? parseWeightInput(text, "g") : null;
  return { mg: mg != null && mg > 0 ? mg : 0, unit: entryUnitFromInput(text) ?? "" };
}

/** One unit's weight, written in the unit the table showed it in, for the CSV reader. */
function weightCell(lineMg: number, qty: number, unit: Unit | ""): string {
  if (lineMg <= 0) return "";
  const one = lineMg / Math.max(1, qty);
  return unit ? `${+fromMg(one, unit).toFixed(6)} ${unit}` : `${+(one / 1000).toFixed(3)} g`;
}

/**
 * A Markdown table as CSV text for csvToListData, or null when the text holds no table
 * (no rule row under a row of pipes), so the caller reads it as it always did.
 */
export function markdownTableRows(text: string): string | null {
  const lines = text.split(/\r\n?|\n/).map((l) => l.trim());
  if (!lines.some((l, i) => i > 0 && RULE.test(l) && l.includes("|") && lines[i - 1]!.startsWith("|"))) return null;

  const ours: Row[] = [];
  let generic: { header: string[]; rows: string[][] } | null = null;
  let category = "";
  let header: string[] | null = null;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      // "# Title" is the list's name, not a folder
      if (heading[1]!.length > 1) category = heading[2]!.trim();
      header = null;
      continue;
    }
    if (!line.startsWith("|")) {
      header = null;
      continue;
    }
    if (RULE.test(line)) continue;
    const row = cells(line);
    if (!header) {
      header = row.map((c) => c.toLowerCase());
      continue;
    }
    const isOurs = header.length === 3 && header[0] === "item" && header[1] === "qty" && header[2] === "weight";
    if (!isOurs) {
      generic ??= { header: ["category", ...header], rows: [] };
      generic.rows.push([category, ...row]);
      continue;
    }
    const item = readItemCell(row[0] ?? "");
    const qtyCell = row[1] ?? "";
    const water = isWaterName(item.name);
    const { mg, unit } = readWeight(row[2] ?? "");
    const entry: Row = {
      category,
      name: item.name,
      gearType: item.gearType,
      note: item.note,
      person: item.person,
      // water's cell is its volume ("2 L"), never a count
      qty: water ? 1 : Math.max(1, Number.parseInt(qtyCell, 10) || 1),
      wornQty: Number(/\((\d+) worn\)/.exec(qtyCell)?.[1] ?? 0),
      lineMg: mg,
      unit,
      bare: !qtyCell,
      children: [],
    };
    const group = ours.at(-1);
    if (item.nested && group) group.children.push(entry);
    else ours.push(entry);
  }

  if (ours.length) {
    const out = ["Category,Item Name,Gear Type,Qty,Weight,Worn Qty,Person,Description,Nested Under"];
    const line = (r: Row, lineMg: number, parent: string) =>
      [r.category, r.name, r.gearType, r.qty, weightCell(lineMg, r.qty, r.unit), r.wornQty || "", r.person, r.note, parent]
        .map(csvCell)
        .join(",");
    for (const r of ours) {
      // A group's Weight cell is its TOTAL, its rows' lines included, so what it holds of
      // its own is the difference; a bare group (no count shown) holds nothing.
      const inside = r.children.reduce((sum, c) => sum + c.lineMg, 0);
      const own = r.children.length ? (r.bare ? 0 : Math.max(0, r.lineMg - inside)) : r.lineMg;
      out.push(line(r, own, ""));
      for (const c of r.children) out.push(line({ ...c, category: r.category }, c.lineMg, r.name));
    }
    return out.join("\n");
  }
  if (generic) return [generic.header, ...generic.rows].map((r) => r.map(csvCell).join(",")).join("\n");
  return null;
}
