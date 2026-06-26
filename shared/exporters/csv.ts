// CSV export + import — hand-rolled (no deps). Round-trips with our own export
// and ingests LighterPack's "Export to CSV" output (flexible header detection).

import type { ListData, ListSnapshot, Unit } from "../types";
import { UNITS } from "../types";
import { effectiveClassification, fromMg, toMg } from "../weights";
import { uid } from "../id";

function normalizeUnit(raw: string | undefined, fallback: Unit): Unit {
  const u = (raw || "").trim().toLowerCase();
  if (UNITS.includes(u as Unit)) return u as Unit;
  if (u === "grams" || u === "gram") return "g";
  if (u === "kgs" || u === "kilograms") return "kg";
  if (u === "ounce" || u === "ounces") return "oz";
  if (u === "lbs" || u === "pound" || u === "pounds") return "lb";
  return fallback;
}

const truthy = (v: string | undefined) =>
  !!v && /^(1|true|yes|y|x|worn|consumable)$/i.test(v.trim());

// ---- export ----
export function listToCsv(list: ListSnapshot): string {
  const u = list.displayUnit;
  const esc = (v: unknown) => {
    const s = String(v ?? "");
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
        esc(it.name),
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
      folders.push({ id, name: key, colorKey: "other", defaultClassification: "base", sortOrder: folders.length });
    }
    return folderId.get(key)!;
  };

  const items: ListData["items"] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const name = (row[nameCol] || "").trim();
    if (!name) continue;
    const cat = iCat >= 0 ? row[iCat] : "";
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
      brand: iBrand >= 0 && row[iBrand]?.trim() ? row[iBrand].trim() : undefined,
      unitWeightMg,
      qty,
      classification,
      description: iDesc >= 0 && row[iDesc]?.trim() ? row[iDesc].trim() : undefined,
      productUrl: iUrl >= 0 && row[iUrl]?.trim() ? row[iUrl].trim() : undefined,
      priceCents: isFinite(priceVal) ? Math.round(priceVal * 100) : undefined,
      sortOrder: items.filter((i) => i.folderId === fId).length,
    });
  }
  return { folders, items };
}
