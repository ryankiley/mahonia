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

import type { Folder, Item, ListData, ListMeta, Person, TripDay, Unit, Waypoint } from "../types";
import { UNITS } from "../types";
import {
  MAX_DAYS,
  MAX_FOLDERS,
  MAX_ITEMS,
  MAX_PEOPLE,
  MAX_WAYPOINTS,
  normalizeCalendarDate,
  normalizeDay,
  normalizeFolder,
  normalizeItem,
  normalizePerson,
  normalizeWaypoint,
  ROUTE_END_IDS,
} from "../ops";
import {
  normalizeDistanceUnit,
  normalizeTrailAscentM,
  normalizeTrailDistanceM,
  type DisplayDistanceUnit,
} from "../trailDistance";
import { parseProfile, profileToString } from "../profile";
import { normalizeTrailLabel, normalizeTrailUrl } from "../trailLink";
import { normalizeRouteGeometry } from "../polyline";
import { uid } from "../id";
import { uniquifyPersonNames } from "../people";
import { bySortOrder } from "../weights";

/** The downloaded backup's shape: the list's meta + its full content. */
export function listToJson(list: ListMeta & ListData): string {
  const { title, description, displayUnit, trailUrl, trailLabel, trailDistanceM, trailDistanceUnit, trailProfile, trailAscentM, trailDescentM, routeGeometry, startDate, endDate, folders, items, days, waypoints, people } = list;
  // trailFaviconDataUrl is deliberately absent — it's a per-host cache the server
  // rebuilds, not part of the list the owner authored.
  return JSON.stringify(
    { title, description, displayUnit, trailUrl, trailLabel, trailDistanceM, trailDistanceUnit, trailProfile, trailAscentM, trailDescentM, routeGeometry, startDate, endDate, folders, items, days, waypoints, people },
    null,
    2,
  );
}

/** A parsed backup: meta to seed the new list with + sanitized content. */
export interface JsonImport {
  title?: string;
  description?: string;
  displayUnit?: Unit;
  trailUrl?: string;
  trailLabel?: string;
  trailDistanceM?: number;
  trailDistanceUnit?: DisplayDistanceUnit;
  trailProfile?: string;
  trailAscentM?: number;
  trailDescentM?: number;
  routeGeometry?: string;
  startDate?: string;
  endDate?: string;
  data: ListData;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Parse a "Download JSON" backup back into list content. Returns null when the
 * text isn't JSON or isn't our shape (an object with `folders` + `items`
 * arrays), so callers can fall back to CSV. Content is sanitized through the
 * SAME reducer helpers the server runs on create (normalizeFolder/
 * normalizeItem) — the client never trusts a file, even its own export. Ids
 * are re-minted: a backup's ids are foreign strings, and duplicates must not
 * survive into the new list (they'd break op targeting). The route's two ends
 * are the one exception — see ROUTE_END_IDS below. folderId references
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
    .sort(bySortOrder)
    .map((f, i) => {
      const id = uid();
      // first occurrence wins on a duplicate source id (mirrors addFolder's dedupe)
      if (!folderIdMap.has(f.id)) folderIdMap.set(f.id, id);
      return { ...f, id, sortOrder: i };
    });

  // People before items: the items re-point personId through this map. Same
  // first-occurrence-wins dedupe as folders, for the same op-targeting reason.
  const personIdMap = new Map<string, string>();
  // …then uniquifyPersonNames below: a backup may predate the one-name-per-person
  // rule, and two "Sam"s are two DIFFERENT people here (they carry their own ids),
  // so they're numbered apart rather than merged the way the CSV column merges them
  const people = uniquifyPersonNames((Array.isArray(raw.people) ? raw.people : [])
    .filter(isRecord)
    .slice(0, MAX_PEOPLE)
    .map((p) => normalizePerson(p as unknown as Person))
    .sort(bySortOrder)
    .map((p, i) => {
      const id = uid();
      if (!personIdMap.has(p.id)) personIdMap.set(p.id, id);
      return { ...p, id, sortOrder: i };
    }));

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
    // re-point parentId through the id map; a dangling or self parent → top-level
    let parentId = (it.parentId && itemIdMap.get(it.parentId)) || null;
    if (parentId === id) parentId = null;
    const key = `${folderId}\u0000${parentId}`;
    const sortOrder = perContainer.get(key) ?? 0;
    perContainer.set(key, sortOrder + 1);
    // dangling assignee → unassigned, the same degradation as a dangling folderId
    const personId = (it.personId && personIdMap.get(it.personId)) || undefined;
    return { ...it, id, folderId, parentId, personId, sortOrder };
  });
  // enforce one level: if a re-pointed parent is itself nested, flatten its children to
  // top-level (a hand-edited/2-level backup can't smuggle in deeper trees)
  const topLevel = new Set(items.filter((i) => i.parentId == null).map((i) => i.id));
  for (const it of items) if (it.parentId && !topLevel.has(it.parentId)) it.parentId = null;

  // Waypoints: re-minted ids, re-validated rather than trusted, like the days below.
  // No sortOrder to renumber — route order is the only order — so they sort by alongM,
  // and normalizeWaypoint drops anything that isn't a placed pin.
  //
  // TWO IDS SURVIVE, and they are the reason this isn't a plain uid() map. The route's own
  // ends carry seedRouteEnds' FIXED ids, which is the only thing that makes them
  // recognisable as the route's ends rather than as pins somebody dropped. Re-minting them
  // left a restored backup with a trailhead and a finish nobody could match, so
  // ensureRouteEnds read the pair as missing and added a second one of each — two stacked
  // markers on the first list opened after a restore. Kept on the FIRST occurrence only: a
  // hand-edited file can repeat them, and a duplicate id breaks op targeting.
  const seenEndIds = new Set<string>();
  const waypoints = (Array.isArray(raw.waypoints) ? raw.waypoints : [])
    .filter(isRecord)
    .slice(0, MAX_WAYPOINTS)
    .map((w) => normalizeWaypoint(w as unknown as Waypoint))
    .filter((w): w is Waypoint => w != null)
    .map((w) => {
      if ((ROUTE_END_IDS as readonly string[]).includes(w.id) && !seenEndIds.has(w.id)) {
        seenEndIds.add(w.id);
        return w;
      }
      return { ...w, id: uid() };
    })
    .sort((a, b) => a.alongM - b.alongM);

  // Days: re-minted ids and renumbered order, like folders. Nothing points at a day, so
  // there is no reference map to rebuild — but a backup written before days existed has
  // no array here at all, which is why this coerces rather than assuming one.
  const days = (Array.isArray(raw.days) ? raw.days : [])
    .filter(isRecord)
    .slice(0, MAX_DAYS)
    .map((d) => normalizeDay(d as unknown as TripDay))
    .sort(bySortOrder)
    .map((d, i) => ({ ...d, id: uid(), sortOrder: i }));

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
    // a hand-edited backup can carry any string here, so re-validate rather than clamp:
    // this ends up in a :href on a page strangers open
    trailUrl: normalizeTrailUrl(typeof raw.trailUrl === "string" ? raw.trailUrl : null) ?? undefined,
    trailLabel: normalizeTrailLabel(typeof raw.trailLabel === "string" ? raw.trailLabel : null),
    // re-validated for the same reason: a hand-edited backup can carry a negative,
    // a string or an absurd number, and the normalizer is the one rule for all of them
    trailDistanceM: normalizeTrailDistanceM(raw.trailDistanceM),
    trailDistanceUnit: normalizeDistanceUnit(raw.trailDistanceUnit),
    // The route's SHAPE. listToJson writes it, so not reading it back made the backup
    // lossy in the one way the header promises it isn't — and lossy for the field an
    // owner cannot retype, since it came off a GPX file they may no longer have. It
    // rides the backup DELIBERATELY, where body weight deliberately doesn't: a backup is
    // the owner downloading their own list. Safe by construction on the read views —
    // their "Download JSON" runs on the public snapshot, which has no geometry to write.
    routeGeometry: normalizeRouteGeometry(raw.routeGeometry),
    // Round-tripped through parseProfile rather than trusted: a hand-edited backup can
    // carry any string here, and parseProfile is the one rule for what a profile is
    // (bounded length, finite metres, at least two samples).
    trailProfile: profileToString(parseProfile(raw.trailProfile)),
    trailAscentM: normalizeTrailAscentM(raw.trailAscentM),
    trailDescentM: normalizeTrailAscentM(raw.trailDescentM),
    // Shape-checked on the way in, like the trail URL beside it and for the same
    // reason: a hand-edited backup can carry anything, and a malformed date would
    // render as a real one everywhere downstream. The reducer re-checks on setMeta,
    // so an invalid value here simply doesn't survive the import either way.
    startDate: normalizeCalendarDate(raw.startDate),
    endDate: normalizeCalendarDate(raw.endDate),
    data: { folders, items, days, waypoints, people },
  };
}
