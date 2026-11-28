// CSV export + import — hand-rolled (no deps). Round-trips with our own export
// and ingests LighterPack's "Export to CSV" output (flexible header detection).

import type { ListData, ListSnapshot, Unit } from "../types";
import { colorKeyForName, nextFolderColor, usedColorKeys } from "../categories";
import { MAX_FOLDERS, MAX_ITEMS, MAX_PEOPLE } from "../ops";
import { carrierName } from "../people";
import { effectiveClassificationInFolder, entryUnitFromInput, itemDisplayName, parseDecimal, parseWeightInput, splitWornQty, UNIT_ALIASES } from "../weights";
import { exportSections } from "./rows";
import { csvCell, csvPrice, csvWeight, stripFormulaGuard } from "./csvCell";
import { uid } from "../id";
import { pasteRows, splitWeightTail } from "../pasteList";
import { waterMgFromMl, waterPhrase } from "../water";
import { markdownTableRows } from "./markdownImport";

// Delegate to the shared unit vocabulary (weights.UNIT_ALIASES) so a CSV / LighterPack
// import recognizes the exact same unit words as free-text weight entry. This hand-
// rolled list had drifted — it missed the singular "kilogram" — so importing a row in
// "kilogram" silently fell through to the fallback unit.
function normalizeUnit(raw: string | undefined): Unit {
  const u = (raw || "").trim().toLowerCase();
  return UNIT_ALIASES[u] ?? "g";
}

const truthy = (v: string | undefined) =>
  !!v && /^(1|true|yes|y|x|worn|consumable)$/i.test(v.trim());

// ---- export ----
export function listToCsv(list: ListSnapshot): string {
  const u = list.displayUnit;
  // One lookup table for both the exported folder name and effective class; an export
  // can contain hundreds of rows, so each must not scan every folder twice.
  const folderById = new Map(list.folders.map((folder) => [folder.id, folder]));
  const folderName = (id: string | null) => (id ? folderById.get(id)?.name : undefined) ?? "";

  // Kcal and Person are APPENDED, never inserted: the importer maps columns by
  // header name (see idx() below), but third-party tooling reading our export
  // positionally would break if an existing column shifted.
  const out = [
    "Category,Item Name,Gear Type,Brand,Qty,Weight,Unit,Worn,Consumable,Price,URL,Description,Worn Qty,Kcal,Person,Needs Cooking,Nested Under,Weight (g)",
  ];
  // rows follow what the app shows (exportSections): folders in their order, each
  // folder's items in drag order, then any ungrouped items — so a re-import keeps
  // the visible order. Each top-level row is immediately followed by its
  // nested children so they stay adjacent; each item exports its OWN weight (a
  // container parent's is usually blank), so the flat CSV re-imports with correct
  // totals and no parent/child double-count. A child names its group in the
  // Nested Under column, which is how a re-import nests it again.
  for (const { item, children } of exportSections(list).flatMap((s) => s.rows)) for (const it of [item, ...children]) {
    const cls = effectiveClassificationInFolder(
      it,
      it.folderId ? folderById.get(it.folderId) : undefined,
    );
    // Each row exports in the unit it READS in, not the list's. The Unit column is
    // already per-row and the importer already honours it per-row, so this is what
    // makes a row typed in ounces come back as ounces instead of being flattened to
    // the list's unit on every round-trip.
    const ru = it.entryUnit ?? u;
    const w = csvWeight(it.unitWeightMg, ru);
    // the split gets its OWN column: the boolean Worn column can't carry a count
    // (a split row must not import back as fully worn)
    const wq = splitWornQty(it, cls);
    out.push(
      [
        csvCell(folderName(it.folderId)),
        // brand has its own column, so the name field carries model + variant
        csvCell(itemDisplayName(null, it.name, it.variant)),
        csvCell(it.commonName ?? ""),
        csvCell(it.brand ?? ""),
        it.qty,
        w,
        it.unitWeightMg > 0 ? ru : "",
        cls === "worn" ? "1" : "",
        cls === "consumable" ? "1" : "",
        csvPrice(it.priceCents),
        csvCell(it.productUrl ?? ""),
        csvCell(it.description ?? ""),
        wq > 0 ? wq : "",
        // only meaningful on a consumable row, and that's the only place it's
        // counted (see computeTotals) — so a stale value on a demoted row isn't
        // exported as though it still applied
        cls === "consumable" && it.kcal ? it.kcal : "",
        // The EFFECTIVE carrier (a child falls back to its parent's), materialized per
        // row because the flat CSV loses nesting: a child re-imports as top-level, so
        // an assignment it only inherited has to be written out or it's gone.
        csvCell(carrierName(list, it, it === item ? null : item)),
        it.needsCooking === true ? "1" : "",
        // the group a nested row sits inside, by the Item Name its row carries above it,
        // so a re-import puts it back there (csvToListData's Nested Under); appended last
        csvCell(it === item ? "" : itemDisplayName(null, item.name, item.variant)),
        // The same weight in grams on every row. Weight is in each row's own unit (so a
        // row typed in ounces comes back in ounces), which a spreadsheet can't add up: a
        // list with rows in lb, oz and g summed to 376 against a real 31 lb. This column
        // is the one to sum. The importer reads Weight, never this.
        csvWeight(it.unitWeightMg, "g"),
      ].join(","),
    );
  }
  return out.join("\n");
}

// ---- parse ----
/** RFC4180-ish: handles quoted fields, escaped "" quotes, commas/newlines in quotes, CRLF.
 *  `delimiter` is a comma unless the caller sniffed another (sniffDelimiter). */
export function parseCsv(text: string, delimiter: "," | "\t" | ";" = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = String(text).replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // drop fully-empty rows
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * The separator a pasted table uses, read off its first line outside quotes: a tab for
 * cells copied out of a spreadsheet, a semicolon for a CSV saved where the decimal is a
 * comma, else a comma. A tab wins a tie with commas, since a copied row's cells can hold
 * commas of their own ("Quilt 25F, Large") while a CSV's never hold a bare tab.
 */
export function sniffDelimiter(text: string): "," | "\t" | ";" {
  const first = text.split(/\r\n?|\n/).find((l) => l.trim()) ?? "";
  let comma = 0;
  let tab = 0;
  let semi = 0;
  let quoted = false;
  for (const c of first) {
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === ",") comma++;
    else if (c === "\t") tab++;
    else if (c === ";") semi++;
  }
  if (tab > 0 && tab >= comma) return "\t";
  return semi > comma ? ";" : ",";
}

// Our own plain-text copy ends on a summary, "Base weight 3.16 kg, 7.65 kg total — full
// list at …": the list's totals, never an item in it.
const TOTALS_LINE = /^base weight\b.*\btotal\b/i;

/**
 * A line split at its commas, when it is a run of names ("Duplex, Arc Quilt, NeoAir,
 * Lone Peaks"), the shape our plain-text copy and a typed comment both take. Two commas
 * at least: one is a name or a weight set off ("Tent, 540 g"). Only a comma with a space
 * after it, outside brackets, so "1,5 kg" and "Quilt (20F, 600 g)" stay whole.
 */
function commaRun(line: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    else if (c === "," && depth === 0 && line[i + 1] === " ") {
      parts.push(line.slice(start, i));
      start = i + 2;
    }
  }
  parts.push(line.slice(start));
  return parts.length >= 3 ? parts : [line];
}

/**
 * Text with no header row, as a CSV the rest of the importer reads: one item per line,
 * the way a list is typed in a phone's notes. Each line is read the way the editor reads
 * a pasted line (shared/pasteList): bullets and checkboxes off, a trailing weight split
 * from the name ("Tent 540 g"), water by its volume. A trailing "×2" is the count, as our
 * plain-text copy writes it, and a heading line ("# Shelter", "Shelter:") names the
 * folder for the lines under it. Returns "" for text with no item in it.
 */
function typedListCsv(text: string): string {
  const out: string[] = [];
  let category = "";
  let headed = false;
  for (const raw of text.split(/\r\n|[\r\n\u2028\u2029\v\f]/)) {
    if (TOTALS_LINE.test(raw.trim())) continue;
    for (const piece of commaRun(raw.trim())) {
      const line = pasteRows(piece)[0];
      if (!line) continue;
      const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1] ?? /^([^:]{1,60}):$/.exec(line)?.[1];
      if (heading) {
        category = heading.trim();
        headed = true;
        continue;
      }
      const water = waterPhrase(line);
      if (water) {
        out.push([category, water.name, "1", `${waterMgFromMl(water.ml) / 1000} g`].map(csvCell).join(","));
        continue;
      }
      const times = /^(.*\S)\s+[×x]\s?(\d{1,4})$/i.exec(line);
      const { name, weight } = splitWeightTail(times ? times[1]! : line);
      out.push([category, name, times ? times[2]! : "1", weight ?? ""].map(csvCell).join(","));
    }
  }
  if (!out.length) return "";
  // no heading anywhere: no Category column, so the rows file under "Imported" as any
  // file without one does, rather than as rows in no folder
  return ["Category,Item Name,Qty,Weight", ...out].map((r) => (headed ? r : r.slice(r.indexOf(",") + 1))).join("\n");
}

/** Import limits that depend on the thing receiving the CSV. */
export interface CsvImportOptions {
  /** A packing list holds 50 folders; a vault has its own, larger ceiling. */
  maxFolders?: number;
  /** A packing list holds 1,000 items. The vault counts differently — it drops the
   *  rows that aren't gear before applying its own ceiling — so it lifts this one. */
  maxItems?: number;
}

/** What a CSV reads as: the list's content, and the unit most of its rows were
 *  written in when one unit outnumbers the rest, which is the list's own. */
/** `typed`: read as a list typed one item a line, not as a table or a CSV. The import
 *  dialog follows a Mahonia link only in such text; a table is read as pasted. */
export type CsvListData = ListData & { displayUnit?: Unit; typed?: true };

/** Map a CSV (ours or LighterPack's) into ListData. Tolerant of column order/naming. */
export function csvToListData(
  text: string,
  { maxFolders = MAX_FOLDERS, maxItems = MAX_ITEMS }: CsvImportOptions = {},
): CsvListData {
  // Our own Markdown copy, or any table written the GitHub way, read as the rows it
  // holds (shared/exporters/markdownImport). It was 140 rows of pipes and dashes.
  const table = markdownTableRows(text);
  if (table) return csvToListData(table, { maxFolders, maxItems });
  // A table copied out of a spreadsheet is tab-separated, and a CSV saved by Excel in a
  // locale that writes the decimal as a comma is semicolon-separated. Both were read as
  // one column, each whole row an item's name.
  const delimiter = sniffDelimiter(text);
  const rows = parseCsv(text, delimiter);
  if (!rows.length) return { folders: [], items: [] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) => {
    for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  const iName = idx(["item name", "name", "item"]);
  // "common name" was this column's header before it was renamed to Gear Type — keep it
  // (and its variants) accepted, or every CSV exported before the rename stops round-tripping.
  // Deliberately NOT bare "type" or "common": "Type" is a very common spelling of CATEGORY in
  // third-party gear spreadsheets, and a wrong hit here is stamped commonNameOverridden below,
  // which pins it against every later correction.
  const iCommon = idx(["gear type", "geartype", "common name", "commonname"]);
  const iCat = idx(["category", "folder", "section"]);
  const iBrand = idx(["brand", "maker", "manufacturer"]);
  const iQty = idx(["qty", "quantity", "count"]);
  let iWeight = idx(["weight", "wt"]);
  // A weight column whose header names its unit, the way a hand-made spreadsheet says
  // it with no Unit column beside it: "Weight (oz)", "Weight [g]", "weight_g", "Grams",
  // "oz". Its figures were dropped, every row at 0. Only when no column is plain
  // "Weight": ours has one, and its unit is per row.
  let weightUnit: Unit | undefined;
  if (iWeight < 0) {
    for (let i = 0; i < header.length && iWeight < 0; i++) {
      const named = /^(?:weight|wt)(?![a-z])[\s_(\[-]*([a-z.]+)[)\]]?$/.exec(header[i]!)?.[1] ?? header[i]!;
      const u = UNIT_ALIASES[named.replace(/\.$/, "")];
      if (u) ((iWeight = i), (weightUnit = u));
    }
  }
  const iUnit = idx(["unit", "units"]);
  const iWorn = idx(["worn"]);
  const iCons = idx(["consumable", "consumables"]);
  const iWornQty = idx(["worn qty", "wornqty", "worn quantity"]);
  // A file's "price" column is dropped on import: no list surface shows or edits a
  // price, so an imported one would ride the row unseen. A row holds a price only
  // when it came with a piece picked from My Gear, and that is what the export's
  // Price column prints, for the owner alone (rowToSnapshot strips it from a share
  // read). productUrl is kept: it's not a price, and it seeds the future
  // canonical-URL affiliate tagging.
  const iUrl = idx(["url", "link", "product url"]);
  const iDesc = idx(["desc", "description", "notes", "note"]);
  // Calories, unlike Price, ARE kept — this is our own column and the field is
  // visible and editable in the app, so dropping it would lose real user data on
  // every export/import round-trip. Absent (a LighterPack CSV, or one of ours from
  // before the column existed) → idx returns -1 and every row reads undefined.
  const iKcal = idx(["kcal", "calories", "cal"]);
  const iCooking = idx(["needs cooking", "needscooking"]);
  // Who carries the row — our own column, kept for the same reason as Kcal.
  // Absent everywhere but our own exports, so a LighterPack file imports peopleless.
  const iPerson = idx(["person", "carried by", "carriedby", "assigned to", "assignedto"]);
  // The row this one sits inside, by that row's Item Name. Our own export writes it, so a
  // group's rows come back inside it rather than as a flat run with an empty row on top.
  const iNested = idx(["nested under"]);

  // A first row that names no column we read, and isn't split into cells the way a CSV
  // is, isn't a header: it's the first item. Text like that is a list typed one item per
  // line (a phone's notes, a comment), and taking its first line as column names lost
  // that line, and with our own plain-text copy, the whole list, which is one line. It's
  // read the way it was written instead. "Cells the way a CSV is": more than one, with a
  // comma that has no space after it ("thing,grams"), or any tab or semicolon; a comma
  // and a space is prose ("Duplex, Arc Quilt, NeoAir").
  const known = [iName, iCommon, iCat, iBrand, iQty, iWeight, iUnit, iWorn, iCons, iWornQty, iUrl, iDesc, iKcal, iCooking, iPerson, iNested];
  const firstLine = text.split(/\r\n?|\n/).find((l) => l.trim()) ?? "";
  const prose = rows[0]!.length < 2 || (delimiter === "," && !/,(?! )/.test(firstLine));
  if (known.every((i) => i < 0) && prose) {
    const typed = typedListCsv(text);
    return { ...(typed ? csvToListData(typed, { maxFolders, maxItems }) : { folders: [], items: [] }), typed: true };
  }
  if (rows.length < 2) return { folders: [], items: [] };
  const nameCol = iName >= 0 ? iName : 0;

  const folders: ListData["folders"] = [];
  const folderId = new Map<string, string>();
  const ensureFolder = (name: string): string | null => {
    const key = name.trim();
    if (!key) return null;
    if (!folderId.has(key)) {
      // Match createList's hard limit before the import reaches catalog matching or
      // the create request. Without this, a large CSV built an over-limit client
      // payload, then the server silently changed its shape under the user.
      if (folders.length >= maxFolders) return null;
      const id = uid();
      folderId.set(key, id);
      // name-match first (Water→blue, First Aid→red), palette walk as the fallback:
      // the same rule addFolder applies, so an imported list and a hand-built one
      // with the same folder names wear the same colours
      const colorKey = colorKeyForName(key, usedColorKeys(folders));
      folders.push({ id, name: key, colorKey, defaultClassification: "base", sortOrder: folders.length });
    }
    return folderId.get(key)!;
  };

  // People mirror folders: dedupe by the name as written, colors from the same
  // palette walk. Rows past the cap import fine, just unassigned — losing an
  // assignment beats losing the gear.
  const people: NonNullable<ListData["people"]> = [];
  const personId = new Map<string, string>();
  const ensurePerson = (name: string | undefined): string | undefined => {
    const key = (name ?? "").trim();
    if (!key) return undefined;
    if (!personId.has(key)) {
      if (people.length >= MAX_PEOPLE) return undefined;
      const id = uid();
      personId.set(key, id);
      // seeded with the folders' hues too, like the editor's addPerson — one
      // color, one meaning, even when both sets render side by side
      const colorKey = nextFolderColor(usedColorKeys([...folders, ...people]));
      people.push({ id, name: key, colorKey, sortOrder: people.length });
    }
    return personId.get(key)!;
  };

  const items: ListData["items"] = [];
  // per-folder running count → O(1) sortOrder instead of rescanning all prior
  // items each row (an O(n²) blowup on a big LighterPack import).
  const folderCount = new Map<string | null, number>();
  // the latest top-level row by name, for the Nested Under column
  const groupAbove = new Map<string, ListData["items"][number]>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    // one optional text cell: absent column, or blank after trimming → undefined (the
    // shape every optional Item field wants), else the de-fanged value
    const cell = (i: number) => {
      const v = i >= 0 ? row[i]?.trim() : "";
      return v ? stripFormulaGuard(v) : undefined;
    };
    const name = stripFormulaGuard((row[nameCol] || "").trim());
    // the unit a bare figure is in: the row's Unit cell, else the one the column's
    // header names ("Weight (oz)"), else grams
    const unitCell = iUnit >= 0 ? (row[iUnit] ?? "").trim() : "";
    const unit = unitCell ? normalizeUnit(unitCell) : (weightUnit ?? "g");
    // Read as the weight field reads a typed one (the one rule a typed number is, in
    // shared/typedNumber), so a cell that names its own unit means it: "21 oz" under a
    // header that names none was 21 g, the leading figure with its unit thrown away.
    const weightCell = iWeight >= 0 ? (row[iWeight] ?? "").trim() : "";
    const weightMg = weightCell ? parseWeightInput(weightCell, unit) : null;
    const unitWeightMg = weightMg != null && weightMg > 0 ? weightMg : 0;
    // A row needs a name OR a weight to be gear. Skipping on the name alone deleted a
    // real row, and its weight, on a round-trip through our own export -- an unnamed
    // item is a normal state in the editor (a row you weighed before you named it).
    // But "carries anything at all" is too loose in the other direction: a
    // category-only separator line, or a stray row holding just a Price cell, is a
    // spacer in someone's spreadsheet, and importing it as a nameless 0 g item puts
    // a phantom row in the list.
    if (!name && unitWeightMg <= 0) continue;
    // The server caps persisted lists at MAX_ITEMS. Stop at the same boundary here
    // so the client never spends work matching or sending rows it cannot keep.
    if (items.length >= maxItems) break;
    const gearType = cell(iCommon); // read once — it also decides the override flag below
    const cat = iCat >= 0 ? stripFormulaGuard(row[iCat] ?? "") : "";
    // A blank Category is a row in no folder, as our own export writes one; only a file
    // with no Category column at all is filed under "Imported", for want of anything
    // better. Unfiled rows used to come back in an "Imported" folder of their own.
    const fId = iCat >= 0 ? ensureFolder(cat) : ensureFolder("Imported");
    // A written 0 stays 0: the default is only for a cell that is absent or unreadable.
    const qtyNum = iQty >= 0 ? parseDecimal(row[iQty] || "") : NaN;
    const qty = Math.max(0, Math.round(Number.isFinite(qtyNum) ? qtyNum : 1));
    const classification = iWorn >= 0 && truthy(row[iWorn])
      ? "worn"
      : iCons >= 0 && truthy(row[iCons])
        ? "consumable"
        : null;
    // the worn split only applies to base rows (normalizeItem re-clamps server-side)
    const wornQtyVal = iWornQty >= 0 && classification === null
      ? Math.round(parseDecimal(row[iWornQty] || "") || 0)
      : 0;
    // Only remember a unit the file actually NAMED. With no Unit column,
    // normalizeUnit returns the fallback — recording that would pin every row of a
    // unitless CSV to a unit nobody chose, and the list's own unit already covers it.
    const namedUnit = entryUnitFromInput(weightCell) ?? (unitCell ? unit : weightUnit);
    // kcal only rides along on rows this import classes as consumable, matching
    // where the app lets it be edited and counted
    // (read as the calories field reads a typed one: the same rule, rounded whole)
    const kcalNum = iKcal >= 0 ? parseDecimal(row[iKcal] || "", { whole: true }) || 0 : 0;

    // inside the nearest group above it with that name ("Monday" twice in one folder is
    // two days, each holding the rows under it), in that group's folder; a name that
    // matches no row above stays where it is, at the top level. A blank cell names no
    // group: it is what every top-level row writes, and a row with no name is no group.
    const nestedUnder = iNested >= 0 ? cell(iNested) : undefined;
    const parent = nestedUnder ? groupAbove.get(nestedUnder) : undefined;
    const item: ListData["items"][number] = {
      id: uid(),
      folderId: parent ? parent.folderId : fId,
      name,
      commonName: gearType,
      // an imported gear type is the user's — mark it overridden so a catalog re-link
      // (if the name matches a catalog row) can't overwrite it
      commonNameOverridden: gearType ? true : undefined,
      brand: cell(iBrand),
      unitWeightMg,
      entryUnit: unitWeightMg > 0 ? namedUnit : undefined,
      qty,
      wornQty: wornQtyVal > 0 ? Math.min(wornQtyVal, qty) : undefined,
      classification,
      kcal: classification === "consumable" && kcalNum > 0 ? kcalNum : undefined,
      needsCooking: truthy(row[iCooking]) || undefined,
      description: cell(iDesc),
      productUrl: cell(iUrl),
      personId: ensurePerson(cell(iPerson)),
      sortOrder: 0,
    };
    // a group's rows are numbered among themselves, the folder's top-level rows apart
    const slot = parent ? parent.id : fId;
    item.sortOrder = folderCount.get(slot) ?? 0;
    folderCount.set(slot, item.sortOrder + 1);
    if (parent) item.parentId = parent.id;
    else if (name) groupAbove.set(name, item);
    items.push(item);
  }

  // Tell the LIST's unit apart from a per-row choice.
  //
  // Our own export writes a Unit cell on every row — `entryUnit ?? displayUnit` — so
  // after a round-trip every row names a unit and the naive reading was that every row
  // had chosen one. A plain gram list exported and re-imported came back with all its
  // rows pinned to "g", and the totals bar's unit switcher then moved the headline
  // figure while every row stayed in grams. Nobody had asked for that on any row.
  //
  // The unit that appears on MOST rows is the list's; the ones that differ are the
  // deliberate ones. That is exactly the shape the exporter produces, and it is also
  // true of a LighterPack file, where a single-unit export means the list's unit.
  // A row keeps its entryUnit only by disagreeing with the crowd.
  // A tie is NOT a majority: on a two-row file with one gram row and one ounce row,
  // neither unit is evidence of the list's own, and dropping whichever happened to be
  // counted first would throw away the deliberate one. Only a unit that outnumbers
  // every other counts as the list's.
  const tally = new Map<string, number>();
  for (const it of items) if (it.entryUnit) tally.set(it.entryUnit, (tally.get(it.entryUnit) ?? 0) + 1);
  let dominant: string | undefined;
  let best = 0;
  let runnerUp = 0;
  for (const [u, n] of tally) {
    if (n > best) ((runnerUp = best), (best = n), (dominant = u));
    else if (n > runnerUp) runnerUp = n;
  }
  const listUnit = dominant && best > runnerUp ? (dominant as Unit) : undefined;
  if (listUnit) {
    for (const it of items) if (it.entryUnit === listUnit) delete it.entryUnit;
  }

  // the key only when the file named anyone — a peopleless import (every
  // LighterPack file) keeps the exact shape it always produced
  const data: CsvListData = people.length ? { folders, items, people } : { folders, items };
  // And the list's unit, the one the crowd agreed on, for the create to use. Dropped
  // from the rows and handed to nobody, a pounds list came back as grams: South
  // Sister's 59 lb rows read in grams, its 2 oz rows in ounces.
  if (listUnit) data.displayUnit = listUnit;
  return data;
}
