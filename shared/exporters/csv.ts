// CSV export + import — hand-rolled (no deps). Round-trips with our own export
// and ingests LighterPack's "Export to CSV" output (flexible header detection).

import type { Item, ListData, ListSnapshot, Unit } from "../types";
import { nextFolderColor } from "../categories";
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
export function stripFormulaGuard(s: string): string {
  return s.length > 1 && s[0] === "'" && FORMULA_LEAD.test(s.slice(1)) ? s.slice(1) : s;
}

// ---- export ----
export function listToCsv(list: ListSnapshot): string {
  const u = list.displayUnit;
  const esc = (v: unknown) => {
    const s = guardFormula(String(v ?? ""));
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const folderName = (id: string | null) =>
    list.folders.find((f) => f.id === id)?.name ?? "";

  const out = [
    "Category,Item Name,Gear Type,Brand,Qty,Weight,Unit,Worn,Consumable,Price,URL,Description,Worn Qty",
  ];
  // rows follow what the app shows (exportSections): folders in their order, each
  // folder's items in its chosen sort, then any ungrouped items — so a re-import of a
  // name/weight-sorted list bakes that visible order in (CSV has no sort field; JSON
  // round-trips sortBy itself). Each top-level row is immediately followed by its
  // nested children so they stay adjacent; each item exports its OWN weight (a
  // container parent's is usually blank), so the flat CSV re-imports with correct
  // totals and no parent/child double-count. (CSV has no nesting column — children
  // re-import as flat top-level rows.)
  const ordered: Item[] = exportSections(list).flatMap((s) =>
    s.rows.flatMap((r) => [r.item, ...r.children]),
  );
  for (const it of ordered) {
    const cls = effectiveClassification(it, list.folders);
    const w = it.unitWeightMg > 0 ? +fromMg(it.unitWeightMg, u).toFixed(u === "g" ? 0 : 3) : "";
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
        it.unitWeightMg > 0 ? u : "",
        cls === "worn" ? "1" : "",
        cls === "consumable" ? "1" : "",
        it.priceCents != null ? (it.priceCents / 100).toFixed(2) : "",
        esc(it.productUrl ?? ""),
        esc(it.description ?? ""),
        wq > 0 ? wq : "",
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
export function csvToListData(text: string, defaultUnit: Unit = "g"): ListData {
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
    const unit = normalizeUnit(iUnit >= 0 ? row[iUnit] : undefined, defaultUnit);
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
      qty,
      wornQty: wornQtyVal > 0 ? Math.min(wornQtyVal, qty) : undefined,
      classification,
      description: cell(iDesc),
      productUrl: cell(iUrl),
      sortOrder: folderCount.get(fId) ?? 0,
    });
    folderCount.set(fId, (folderCount.get(fId) ?? 0) + 1);
  }
  return { folders, items };
}
