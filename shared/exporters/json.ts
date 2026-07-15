// JSON export + import — the menus' "Download JSON" and its restore path in the
// import dialog. Unlike CSV, the export carries the list at FULL fidelity
// (catalog links, override flags, packed state, folder colors/defaults, worn
// splits), so a downloaded file is a real backup: importing it reproduces the
// list exactly, modulo re-minted ids and renumbered sortOrders.

import type { Folder, Item, ListData, ListMeta, Unit } from "../types";
import { UNITS } from "../types";
import { MAX_FOLDERS, MAX_ITEMS, normalizeFolder, normalizeItem } from "../ops";
import { uid } from "../id";

/** The downloaded backup's shape: the list's meta + its full content. */
export function listToJson(list: ListMeta & ListData): string {
  const { title, description, displayUnit, folders, items } = list;
  return JSON.stringify({ title, description, displayUnit, folders, items }, null, 2);
}

/** A parsed backup: meta to seed the new list with + sanitized content. */
export interface JsonImport {
  title?: string;
  description?: string;
  displayUnit?: Unit;
  data: ListData;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Parse a "Download JSON" backup back into list content. Returns null when the
 * text isn't JSON or isn't our shape (an object with `folders` + `items`
 * arrays), so callers can fall back to CSV. Content is sanitized through the
 * SAME reducer helpers the server runs on create (normalizeFolder/
 * normalizeItem) — the client never trusts a file, even its own export. All ids
 * are re-minted: a backup's ids are foreign strings, and duplicates must not
 * survive into the new list (they'd break op targeting). folderId references
 * are re-pointed through the old→new map (dangling → null, like addItem's
 * coercion), and sortOrder is renumbered from the backup's ordering, so a
 * hand-edited file with gaps or ties still imports sanely.
 */
export function jsonToListImport(text: string): JsonImport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw.folders) || !Array.isArray(raw.items)) return null;

  const folderIdMap = new Map<string, string>();
  const folders = raw.folders
    .filter(isRecord)
    .slice(0, MAX_FOLDERS)
    .map((f) => normalizeFolder(f as unknown as Folder))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((f, i) => {
      const id = uid();
      // first occurrence wins on a duplicate source id (mirrors addFolder's dedupe)
      if (!folderIdMap.has(f.id)) folderIdMap.set(f.id, id);
      return { ...f, id, sortOrder: i };
    });

  const perFolder = new Map<string | null, number>();
  const items = raw.items
    .filter(isRecord)
    .slice(0, MAX_ITEMS)
    .map((it) => normalizeItem(it as unknown as Item))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((it) => {
      const folderId = (it.folderId && folderIdMap.get(it.folderId)) || null;
      const sortOrder = perFolder.get(folderId) ?? 0;
      perFolder.set(folderId, sortOrder + 1);
      return { ...it, id: uid(), folderId, sortOrder };
    });

  return {
    // clamps mirror setMeta's (the server re-clamps on create regardless)
    title:
      typeof raw.title === "string" && raw.title.trim() ? raw.title.slice(0, 200) : undefined,
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.slice(0, 4000)
        : undefined,
    displayUnit:
      typeof raw.displayUnit === "string" && UNITS.includes(raw.displayUnit as Unit)
        ? (raw.displayUnit as Unit)
        : undefined,
    data: { folders, items },
  };
}
