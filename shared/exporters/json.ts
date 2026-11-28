// JSON export + import — the menus' "Download JSON" and its restore path in the
// import dialog. Unlike CSV, the export carries the list at FULL fidelity
// (catalog links, override flags, packed state, folder colors/defaults, worn
// splits, the trip's days and the route read off a GPX), so a downloaded file is a real
// backup: importing it reproduces the list exactly, modulo re-minted ids and renumbered
// sortOrders.
//
// That claim is only true while BOTH halves move together. Every field added to
// listToJson has to be read back by jsonToListImport and forwarded by whatever creates
// the list, or the backup quietly becomes lossy in exactly the way this comment denies.
// Body weight is the one deliberate omission, and it is deliberate in both directions:
// see tests/bodyWeightPrivacy.test.ts.

import type { Folder, Item, ListData, ListMeta, Person, TripDay, Waypoint } from "../types";
import { pickListMeta } from "../types";
import { MAX_DAYS, MAX_FOLDERS, MAX_ITEMS, MAX_PEOPLE, MAX_WAYPOINTS, normalizeDay, normalizeFolder, normalizeItem, normalizePerson, normalizeWaypoint } from "../ops";
import { uid } from "../id";
import { colorKeyForName, usedColorKeys } from "../categories";
import { isRecord } from "../record";
import { bySortOrder } from "../weights";

/** The downloaded backup's shape: the list's meta + its full content. The meta in
 *  LIST_META_KEYS order — the key order a person sees in the file. trailFaviconDataUrl
 *  is deliberately absent — it's a per-host cache the server rebuilds, not part of the
 *  list the owner authored. The account takeout wraps this same object per list. */
export function listBackupObject(list: ListMeta & ListData): Record<string, unknown> {
  const { folders, items, days, waypoints, people } = list;
  return { ...pickListMeta(list), folders, items, days, waypoints, people };
}

export function listToJson(list: ListMeta & ListData): string {
  return JSON.stringify(listBackupObject(list), null, 2);
}

/** A parsed backup: meta to seed the new list with + sanitized content. */
type JsonImport = Partial<ListMeta> & { data: ListData };

/**
 * A backup's ordered entities → their stored form: records only, capped, run through
 * the reducer's own normalizer, sorted into their saved order, then each re-minted
 * with a fresh id and renumbered from 0. `idMap` (source id → new id) is filled for
 * the lists something else points at; first occurrence wins on a duplicate source
 * id, mirroring the reducer's add dedupe. Coerces a missing array to nothing: a
 * backup written before a list existed has no key for it at all.
 */
function remintOrdered<T extends { id: string; sortOrder: number }>(
  raw: unknown,
  max: number,
  normalize: (v: T) => T,
  idMap?: Map<string, string>,
): T[] {
  return (Array.isArray(raw) ? raw : [])
    .filter(isRecord)
    .slice(0, max)
    .map((v) => normalize(v as unknown as T))
    .sort(bySortOrder)
    .map((e, i) => {
      const id = uid();
      if (idMap && !idMap.has(e.id)) idMap.set(e.id, id);
      return { ...e, id, sortOrder: i };
    });
}

/**
 * Parse a "Download JSON" backup back into list content. Returns null when the
 * text isn't JSON or isn't our shape (an object with `folders` + `items`
 * arrays), so callers can fall back to CSV.
 *
 * The whole-list healing (caps, dangling references, one nesting level, unique person
 * names, every meta field) is the create's: its normalizeListData and normalizeListMeta
 * run on whatever this returns. What stays here is what the server can't do or what is
 * read before it: rows still go through the reducer's per-entity normalizers, because
 * the catalog matcher reads their names first. Ids are re-minted BEFORE anything else:
 * a backup's ids are foreign strings, and two rows sharing one are two rows here, where
 * the server would keep only the first. References are re-pointed through the old→new
 * maps (dangling → null, like addItem's coercion), and sortOrder is renumbered from the
 * backup's ordering, so a hand-edited file with gaps or ties still imports sanely; the
 * server leaves folder and item order as it finds them.
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
  const folders = remintOrdered<Folder>(raw.folders, MAX_FOLDERS, normalizeFolder, folderIdMap);
  // A folder that came without a usable colour reads "other" (normalizeFolder): give
  // it the hue the editor would, so an imported list isn't all grey. A name that IS
  // the grey bucket (Misc, Other) gets "other" back.
  const hues = usedColorKeys(folders);
  folders.forEach((f, i) => {
    if (hues[i] === "other") f.colorKey = hues[i] = colorKeyForName(f.name, hues);
  });

  // People before items: the items re-point personId through this map. Same
  // first-occurrence-wins dedupe as folders, for the same op-targeting reason.
  const personIdMap = new Map<string, string>();
  const people = remintOrdered<Person>(raw.people, MAX_PEOPLE, normalizePerson, personIdMap);

  const normalized = raw.items
    .filter(isRecord)
    .slice(0, MAX_ITEMS)
    .map((it) => normalizeItem(it as unknown as Item))
    .sort(bySortOrder);
  // Every item gets its OWN fresh id (duplicate source ids must NOT collide). A separate
  // source->new map (first occurrence wins, like folderIdMap) lets a child re-point its
  // parentId even when the parent appears later in the file.
  const itemIdMap = new Map<string, string>();
  const newIds = normalized.map((it) => {
    const id = uid();
    if (!itemIdMap.has(it.id)) itemIdMap.set(it.id, id);
    return id;
  });
  // sortOrder renumbers per CONTAINER (folder + parent), like the reducer
  const perContainer = new Map<string, number>();
  const items = normalized.map((it, k) => {
    const id = newIds[k]!;
    const folderId = (it.folderId && folderIdMap.get(it.folderId)) || null;
    // re-point parentId through the id map; a dangling parent → top-level. A self parent
    // is cleared HERE although the server clears it too, because the container it is
    // numbered in below has to be the one it ends up in. Deeper nesting is left for the
    // server's normalizeListData to flatten: that happens after the numbering either way.
    let parentId = (it.parentId && itemIdMap.get(it.parentId)) || null;
    if (parentId === id) parentId = null;
    const key = `${folderId}\u0000${parentId}`;
    const sortOrder = perContainer.get(key) ?? 0;
    perContainer.set(key, sortOrder + 1);
    // dangling assignee → unassigned, the same degradation as a dangling folderId
    const personId = (it.personId && personIdMap.get(it.personId)) || undefined;
    return { ...it, id, folderId, parentId, personId, sortOrder };
  });

  // Days: re-minted ids and renumbered order, like folders. Nothing points at a day, so
  // there is no reference map to rebuild — but a backup written before days existed has
  // no array here at all, which is why this coerces rather than assuming one.
  // Waypoints, same treatment as days: re-minted ids, re-validated rather than trusted.
  // No sortOrder to renumber — route order is the only order — so they sort by alongM,
  // and normalizeWaypoint drops anything that isn't a placed pin. The route's own two
  // ends are re-minted with the rest: a pin is a route end by its kind, not by its id.
  const waypoints = (Array.isArray(raw.waypoints) ? raw.waypoints : [])
    .filter(isRecord)
    .slice(0, MAX_WAYPOINTS)
    .map((w) => normalizeWaypoint(w as unknown as Waypoint))
    .filter((w): w is Waypoint => w != null)
    .map((w) => ({ ...w, id: uid() }))
    .sort((a, b) => a.alongM - b.alongM);

  const days = remintOrdered<TripDay>(raw.days, MAX_DAYS, normalizeDay);

  // The meta goes through as the file has it: the create's normalizeListMeta validates
  // every field, typeof included (a javascript: trail link, a half-typed date, a unit
  // that is none), and nothing reads these values before the create but the title. The
  // route's shape rides along deliberately, where body weight deliberately doesn't: a
  // backup is the owner downloading their own list.
  const meta = pickListMeta(raw as Partial<ListMeta>);
  // A blank title or description is absent, so the dialog's own "Imported list" applies.
  const blank = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  return {
    ...meta,
    title: blank(raw.title),
    description: blank(raw.description),
    data: { folders, items, days, waypoints, people },
  };
}
