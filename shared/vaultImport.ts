// Putting gear back — the parse half of My Gear's import.
//
// The export shipped without one, which made "Download JSON" a backup you could
// take and never restore. This is the other end of that: our own JSON at full
// fidelity, and any CSV (ours, or a spreadsheet, or LighterPack's) as the gear it
// describes.
//
// Pure, like every other shared/ module the server and the client both run: the
// dialog parses a pasted file with it to say what's in there before sending, and
// the endpoint re-derives everything it stores anyway (vaultRepo's sanitize).

import { csvToListData } from "./exporters/csv";
import type { Item } from "./types";
import {
  VAULT_IMPORT_MAX,
  VAULT_PIN_FIELDS,
  gearFromItem,
  type VaultCapture,
  type VaultPinField,
} from "./vault";

/**
 * A row on its way in: the gear, plus the pins it arrives already holding.
 *
 * Only our own JSON states pins — they are a record of decisions you made on
 * /gear, and restoring them is most of what makes a backup faithful. A CSV states
 * none, and inventing them would be worse than leaving them off: a row pinned on
 * the way in never learns anything from a list again.
 */
export interface VaultImportRow extends VaultCapture {
  pinned?: VaultPinField[];
}

export interface VaultImport {
  rows: VaultImportRow[];
  /** How the file was read, so the dialog can say so before anything is sent. */
  from: "json" | "csv";
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const PINS = new Set<string>(VAULT_PIN_FIELDS);

/**
 * Our own "Download JSON", back.
 *
 * Returns null when the text isn't that shape, so the caller can fall through to
 * CSV — the same sniff-and-fall-back jsonToListImport gives a list backup.
 *
 * Folders arrive as ids on the rows and a table beside them, and leave as NAMES,
 * because that is the only currency a capture speaks: vault folder ids belong to
 * the vault that issued them, and a backup restored into a different account would
 * otherwise file gear under headings that account has never seen. Resolving to the
 * name lets the server's ensureFolders find-or-create exactly as a list capture does.
 */
export function vaultImportFromJson(text: string): VaultImport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null;

  const folderName = new Map<number, string>();
  if (Array.isArray(raw.folders)) {
    for (const f of raw.folders) {
      if (isRecord(f) && typeof f.id === "number" && typeof f.name === "string") {
        folderName.set(f.id, f.name);
      }
    }
  }

  const rows: VaultImportRow[] = [];
  for (const item of raw.items.slice(0, VAULT_IMPORT_MAX)) {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) continue;
    // Everything is carried across as-is and bounded server-side rather than here:
    // sanitize() re-derives the identity and re-clamps every field, so a
    // hand-edited backup can't seed a row the app couldn't have produced. What
    // this loop owns is the SHAPE — which keys exist and what a folder means.
    rows.push({
      normKey: "", // re-derived from the spelling, server-side; never trusted from a file
      name: item.name,
      brand: typeof item.brand === "string" ? item.brand : undefined,
      variant: typeof item.variant === "string" ? item.variant : undefined,
      commonName: typeof item.commonName === "string" ? item.commonName : undefined,
      weightMg: typeof item.weightMg === "number" ? item.weightMg : 0,
      classification: item.classification as VaultCapture["classification"],
      kcal: typeof item.kcal === "number" ? item.kcal : undefined,
      catalogItemId: typeof item.catalogItemId === "number" ? item.catalogItemId : undefined,
      productUrl: typeof item.productUrl === "string" ? item.productUrl : undefined,
      description: typeof item.description === "string" ? item.description : undefined,
      priceCents: typeof item.priceCents === "number" ? item.priceCents : undefined,
      currency: typeof item.currency === "string" ? item.currency : undefined,
      imageUrl: typeof item.imageUrl === "string" ? item.imageUrl : undefined,
      folder: typeof item.folderId === "number" ? folderName.get(item.folderId) : undefined,
      pinned: Array.isArray(item.pinned)
        ? (item.pinned.filter((p) => typeof p === "string" && PINS.has(p)) as VaultPinField[])
        : undefined,
    });
  }
  return { rows, from: "json" };
}

/**
 * Any CSV, as the gear it describes.
 *
 * Runs through csvToListData — the importer that already reads our own export, a
 * LighterPack export and most spreadsheets — and then projects its rows onto gear.
 * One header vocabulary for the whole app rather than a second one here, which is
 * also why the gear CSV was given the list importer's column names in the first
 * place.
 *
 * gearFromItem, not the capture projection: capture's worthiness rule is about
 * what a live editor should bank while you type, and it would drop every row in the
 * file you haven't weighed yet.
 */
export function vaultImportFromCsv(text: string): VaultImport {
  const list = csvToListData(text);
  const name = new Map(list.folders.map((f) => [f.id, f.name]));
  // parents are containers, not gear — the one capture exclusion that still holds
  // for a deliberate import ("Cook kit" is a heading; its children are the gear)
  const parents = new Set(list.items.map((i) => i.parentId).filter(Boolean));
  const rows: VaultImportRow[] = [];
  for (const item of list.items as Item[]) {
    if (parents.has(item.id)) continue;
    const gear = gearFromItem(item, item.folderId ? name.get(item.folderId) : undefined);
    if (gear) rows.push(gear);
    if (rows.length >= VAULT_IMPORT_MAX) break;
  }
  return { rows, from: "csv" };
}

/** JSON if it reads as ours, CSV otherwise — the sniff the list importer makes. */
export function parseVaultImport(text: string): VaultImport {
  const raw = (text ?? "").trim();
  if (raw.startsWith("{")) {
    const json = vaultImportFromJson(raw);
    if (json) return json;
  }
  return vaultImportFromCsv(raw);
}
