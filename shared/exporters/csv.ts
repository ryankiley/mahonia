// CSV export + import — hand-rolled (no deps). Round-trips with our own export
// and ingests LighterPack's "Export to CSV" output (flexible header detection).

import type { Item, ListData, ListSnapshot, Unit } from "../types";
import { nextFolderColor } from "../categories";
import { MAX_PEOPLE } from "../ops";
import { carrierName } from "../people";
import { effectiveClassification, fromMg, itemDisplayName, splitWornQty, toMg, UNIT_ALIASES } from "../weights";
import { exportSections } from "./rows";
import { uid } from "../id";

// Delegate to the shared unit vocabulary (weights.UNIT_ALIASES) so a CSV / LighterPack
// import recognizes the exact same unit words as free-text weight entry. This hand-
// rolled list had drifted — it missed the singular "kilogram" — so importing a row in
// "kilogram" silently fell through to the fallback unit.
function normalizeUnit(raw: string | undefined, fallback: Unit): Unit {
  const u = (raw || "").trim().toLowerCase();
  return UNIT_ALIASES[u] ?? fallback;
}

const truthy = (v: string | undefined) =>
  !!v && /^(1|true|yes|y|x|worn|consumable)$/i.test(v.trim());

// A leading =, +, -, @, or a control char (tab/CR) makes a spreadsheet treat the
// cell as a formula/command (CSV injection / DDE) when the export is opened in
// Excel/Sheets — dangerous because list content can come from another user (a
// shared edit link, or a LighterPack import). Neutralize by prefixing a single
// quote, the standard mitigation; stripFormulaGuard() removes it again on import
// so our own round-trip is lossless.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const guardFormula = (s: string) => (FORMULA_LEAD.test(s) ? `'${s}` : s);
function stripFormulaGuard(s: string): string {
  return s.length > 1 && s[0] === "'" && FORMULA_LEAD.test(s.slice(1)) ? s.slice(1) : s;
}

// ---- export ----
export function listToCsv(list: ListSnapshot): string {
  const u = list.displayUnit;
  const esc = (v: unknown) => {
    const s = guardFormula(String(v ?? ""));
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // one lookup table, not a folders.find() per row
  const folderById = new Map(list.folders.map((f) => [f.id, f.name]));
  const folderName = (id: string | null) => (id ? folderById.get(id) : undefined) ?? "";

  // Kcal and Person are APPENDED, never inserted: the importer maps columns by
  // header name (see idx() below), but third-party tooling reading our export
  // positionally would break if an existing column shifted.
  const out = [
    "Category,Item Name,Gear Type,Brand,Qty,Weight,Unit,Worn,Consumable,Price,URL,Description,Worn Qty,Kcal,Person",
  ];
  // The EFFECTIVE carrier (a child falls back to its parent's), materialized per
  // row because the flat CSV loses nesting: a child re-imports as top-level, so
  // an assignment it only inherited has to be written out or it's gone.
  const itemById = new Map(list.items.map((i) => [i.id, i]));
  const carrierOf = (it: Item) => carrierName(list, it, it.parentId ? itemById.get(it.parentId) : null);
  // rows follow what the app shows (exportSections): folders in their order, each
  // folder's items in drag order, then any ungrouped items — so a re-import keeps
  // the visible order. Each top-level row is immediately followed by its
  // nested children so they stay adjacent; each item exports its OWN weight (a
  // container parent's is usually blank), so the flat CSV re-imports with correct
  // totals and no parent/child double-count. (CSV has no nesting column — children
  // re-import as flat top-level rows.)
  const ordered: Item[] = exportSections(list).flatMap((s) =>
    s.rows.flatMap((r) => [r.item, ...r.children]),
  );
  for (const it of ordered) {
    const cls = effectiveClassification(it, list.folders);
    // Each row exports in the unit it READS in, not the list's. The Unit column is
    // already per-row and the importer already honours it per-row, so this is what
    // makes a row typed in ounces come back as ounces instead of being flattened to
    // the list's unit on every round-trip.
    const ru = it.entryUnit ?? u;
    const w = it.unitWeightMg > 0 ? +fromMg(it.unitWeightMg, ru).toFixed(ru === "g" ? 0 : 3) : "";
    // the split gets its OWN column: the boolean Worn column can't carry a count
    // (a split row must not import back as fully worn)
    const wq = splitWornQty(it, cls);
    out.push(
      [
        esc(folderName(it.folderId)),
        // brand has its own column, so the name field carries model + variant
        esc(itemDisplayName(null, it.name, it.variant)),
        esc(it.commonName ?? ""),
        esc(it.brand ?? ""),
        it.qty,
        w,
        it.unitWeightMg > 0 ? ru : "",
        cls === "worn" ? "1" : "",
        cls === "consumable" ? "1" : "",
        it.priceCents != null ? (it.priceCents / 100).toFixed(2) : "",
        esc(it.productUrl ?? ""),
        esc(it.description ?? ""),
        wq > 0 ? wq : "",
        // only meaningful on a consumable row, and that's the only place it's
        // counted (see computeTotals) — so a stale value on a demoted row isn't
        // exported as though it still applied
        cls === "consumable" && it.kcal ? it.kcal : "",
        esc(carrierOf(it)),
      ].join(","),
    );
  }
  return out.join("\n");
}

// ---- parse ----
/** RFC4180-ish: handles quoted fields, escaped "" quotes, commas/newlines in quotes, CRLF. */
export function parseCsv(text: string): string[][] {
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
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // drop fully-empty rows
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Map a CSV (ours or LighterPack's) into ListData. Tolerant of column order/naming. */
export function csvToListData(text: string): ListData {
  const rows = parseCsv(text);
  if (rows.length < 2) return { folders: [], items: [] };
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
  const iWeight = idx(["weight", "wt"]);
  const iUnit = idx(["unit", "units"]);
  const iWorn = idx(["worn"]);
  const iCons = idx(["consumable", "consumables"]);
  const iWornQty = idx(["worn qty", "wornqty", "worn quantity"]);
  // Mahonia doesn't do prices — a LighterPack/CSV "price" column is dropped on
  // import rather than silently carried (invisible in the editor, but re-emitted
  // on export). productUrl is kept: it's not a price, and it seeds the future
  // canonical-URL affiliate tagging.
  const iUrl = idx(["url", "link", "product url"]);
  const iDesc = idx(["desc", "description", "notes", "note"]);
  // Calories, unlike Price, ARE kept — this is our own column and the field is
  // visible and editable in the app, so dropping it would lose real user data on
  // every export/import round-trip. Absent (a LighterPack CSV, or one of ours from
  // before the column existed) → idx returns -1 and every row reads undefined.
  const iKcal = idx(["kcal", "calories", "cal"]);
  // Who carries the row — our own column, kept for the same reason as Kcal.
  // Absent everywhere but our own exports, so a LighterPack file imports peopleless.
  const iPerson = idx(["person", "carried by", "carriedby", "assigned to", "assignedto"]);
  const nameCol = iName >= 0 ? iName : 0;

  const folders: ListData["folders"] = [];
  const folderId = new Map<string, string>();
  const ensureFolder = (name: string): string | null => {
    const key = name.trim();
    if (!key) return null;
    if (!folderId.has(key)) {
      const id = uid();
      folderId.set(key, id);
      const colorKey = nextFolderColor(folders.map((f) => f.colorKey ?? "other"));
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
      const colorKey = nextFolderColor([
        ...folders.map((f) => f.colorKey ?? "other"),
        ...people.map((p) => p.colorKey ?? "other"),
      ]);
      people.push({ id, name: key, colorKey, sortOrder: people.length });
    }
    return personId.get(key)!;
  };

  const items: ListData["items"] = [];
  // per-folder running count → O(1) sortOrder instead of rescanning all prior
  // items each row (an O(n²) blowup on a big LighterPack import).
  const folderCount = new Map<string | null, number>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    // one optional text cell: absent column, or blank after trimming → undefined (the
    // shape every optional Item field wants), else the de-fanged value
    const cell = (i: number) => {
      const v = i >= 0 ? row[i]?.trim() : "";
      return v ? stripFormulaGuard(v) : undefined;
    };
    const name = stripFormulaGuard((row[nameCol] || "").trim());
    if (!name) continue;
    const gearType = cell(iCommon); // read once — it also decides the override flag below
    const cat = iCat >= 0 ? stripFormulaGuard(row[iCat] ?? "") : "";
    const fId = ensureFolder(cat || "Imported");
    const unit = normalizeUnit(iUnit >= 0 ? row[iUnit] : undefined, "g");
    const weightNum = iWeight >= 0 ? parseFloat((row[iWeight] || "").replace(/,/g, "")) : 0;
    const unitWeightMg = isFinite(weightNum) && weightNum > 0 ? toMg(weightNum, unit) : 0;
    const qty = iQty >= 0 ? Math.max(1, Math.round(parseFloat(row[iQty] || "") || 1)) : 1;
    const classification = iWorn >= 0 && truthy(row[iWorn])
      ? "worn"
      : iCons >= 0 && truthy(row[iCons])
        ? "consumable"
        : null;
    // the worn split only applies to base rows (normalizeItem re-clamps server-side)
    const wornQtyVal = iWornQty >= 0 && classification === null
      ? Math.round(parseFloat(row[iWornQty] || "") || 0)
      : 0;
    // Only remember a unit the file actually NAMED. With no Unit column,
    // normalizeUnit returns the fallback — recording that would pin every row of a
    // unitless CSV to a unit nobody chose, and the list's own unit already covers it.
    const namedUnit = iUnit >= 0 && (row[iUnit] ?? "").trim() ? unit : undefined;
    // kcal only rides along on rows this import classes as consumable, matching
    // where the app lets it be edited and counted
    const kcalNum = iKcal >= 0 ? Math.round(parseFloat((row[iKcal] || "").replace(/,/g, "")) || 0) : 0;

    items.push({
      id: uid(),
      folderId: fId,
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
      description: cell(iDesc),
      productUrl: cell(iUrl),
      personId: ensurePerson(cell(iPerson)),
      sortOrder: folderCount.get(fId) ?? 0,
    });
    folderCount.set(fId, (folderCount.get(fId) ?? 0) + 1);
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
  if (dominant && best > runnerUp) {
    for (const it of items) if (it.entryUnit === dominant) delete it.entryUnit;
  }

  // the key only when the file named anyone — a peopleless import (every
  // LighterPack file) keeps the exact shape it always produced
  return people.length ? { folders, items, people } : { folders, items };
}
