// CSV export + import — hand-rolled (no deps). Round-trips with our own export
// and ingests LighterPack's "Export to CSV" output (flexible header detection).

import type { ListData, ListSnapshot, Unit } from "../types";
import { nextFolderColor } from "../categories";
import { effectiveClassification, fromMg, itemDisplayName, itemsInFolder, toMg, UNIT_ALIASES } from "../weights";
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
    "Category,Item Name,Brand,Qty,Weight,Unit,Worn,Consumable,Price,URL,Description",
  ];
  for (const it of list.items) {
    const cls = effectiveClassification(it, list.folders);
    const w = it.unitWeightMg > 0 ? +fromMg(it.unitWeightMg, u).toFixed(u === "g" ? 0 : 3) : "";
    out.push(
      [
        esc(folderName(it.folderId)),
        // brand has its own column, so the name field carries model + variant
        esc(itemDisplayName(null, it.name, it.variant)),
        esc(it.brand ?? ""),
        it.qty,
        w,
        it.unitWeightMg > 0 ? u : "",
        cls === "worn" ? "1" : "",
        cls === "consumable" ? "1" : "",
        it.priceCents != null ? (it.priceCents / 100).toFixed(2) : "",
        esc(it.productUrl ?? ""),
        esc(it.description ?? ""),
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
  const iCat = idx(["category", "folder", "section"]);
  const iBrand = idx(["brand", "maker", "manufacturer"]);
  const iQty = idx(["qty", "quantity", "count"]);
  const iWeight = idx(["weight", "wt"]);
  const iUnit = idx(["unit", "units"]);
  const iWorn = idx(["worn"]);
  const iCons = idx(["consumable", "consumables"]);
  const iPrice = idx(["price", "cost"]);
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
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const name = stripFormulaGuard((row[nameCol] || "").trim());
    if (!name) continue;
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
    const priceVal = iPrice >= 0 ? parseFloat((row[iPrice] || "").replace(/[^0-9.]/g, "")) : NaN;

    items.push({
      id: uid(),
      folderId: fId,
      name,
      brand: iBrand >= 0 && row[iBrand]?.trim() ? stripFormulaGuard(row[iBrand].trim()) : undefined,
      unitWeightMg,
      qty,
      classification,
      description: iDesc >= 0 && row[iDesc]?.trim() ? stripFormulaGuard(row[iDesc].trim()) : undefined,
      productUrl: iUrl >= 0 && row[iUrl]?.trim() ? stripFormulaGuard(row[iUrl].trim()) : undefined,
      priceCents: isFinite(priceVal) ? Math.round(priceVal * 100) : undefined,
      sortOrder: itemsInFolder(items, fId).length,
    });
  }
  return { folders, items };
}
