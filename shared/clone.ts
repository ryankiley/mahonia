import { uid } from "./id";
import type { Folder, Item, ListSnapshot, Person, TripDay, Waypoint } from "./types";

/**
 * The payload for an independent copy of a list: fresh ids everywhere (so the
 * copy shares nothing with the source), folder→item, parent→child and
 * person→item links remapped, and packed state reset (a copy is a list to pack,
 * not a record of what was packed). Shared by the editor's "Duplicate this
 * list" and the read views' "Duplicate this list" so the two can't drift.
 */
export function cloneListData(
  src: Pick<ListSnapshot, "folders" | "items" | "days" | "waypoints" | "people">,
): { folders: Folder[]; items: Item[]; days: TripDay[]; waypoints: Waypoint[]; people: Person[] } {
  const idMap = new Map<string, string>();
  const folders = src.folders.map((f) => {
    const nid = uid();
    idMap.set(f.id, nid);
    return { ...f, id: nid };
  });
  // People come along WITH their assignments — the crew is part of the plan being
  // copied (the next trip with the same people is exactly why you duplicate),
  // where `packed` below is a record of one packing and resets. Remapped like
  // folders because items point at them; a dangling assignee degrades to
  // unassigned, the same shape as a dangling folderId.
  const personIdMap = new Map<string, string>();
  const people = (src.people ?? []).map((p) => {
    const nid = uid();
    personIdMap.set(p.id, nid);
    return { ...p, id: nid };
  });
  // Two passes (mirrors jsonToListImport) so a child can re-point its parentId even
  // when the parent appears later in the array; a dangling parent degrades to
  // top-level, not a broken link that would render nowhere yet count in totals.
  // jsonToListImport's FURTHER healing (self-parent guard, deep-nest flatten) is
  // deliberately absent here: an import is untrusted text, while a clone's source
  // is an in-app snapshot whose invariants the reducer and the server's
  // normalizeListData already enforce — there is nothing to heal.
  const itemIdMap = new Map<string, string>();
  const newIds = src.items.map((i) => {
    const nid = uid();
    if (!itemIdMap.has(i.id)) itemIdMap.set(i.id, nid);
    return nid;
  });
  const items = src.items.map((i, k) => ({
    ...i,
    id: newIds[k]!,
    folderId: i.folderId ? (idMap.get(i.folderId) ?? null) : null,
    parentId: i.parentId ? (itemIdMap.get(i.parentId) ?? null) : null,
    personId: i.personId ? (personIdMap.get(i.personId) ?? undefined) : undefined,
    packed: false,
  }));
  // Days come along — the itinerary is part of the plan you're copying, not a record of
  // what happened, so unlike `packed` there is nothing here to reset. Fresh ids all the
  // same: the copy must share nothing with its source. Nothing references a day, so
  // there is no map to keep.
  const days = (src.days ?? []).map((d) => ({ ...d, id: uid() }));
  // Waypoints likewise, and for the same reason: they belong to the plan. Fresh ids, no
  // map — nothing references a waypoint either.
  //
  // They copy WITHOUT the route geometry they're measured against, because geometry is
  // meta and this function only handles entities. The copy therefore has pins at known
  // distances along a route it hasn't got yet, which is exactly what happens when the
  // duplicate's own trail link is set: the distances were never coordinates, so they
  // don't go stale, they just wait.
  const waypoints = (src.waypoints ?? []).map((w) => ({ ...w, id: uid() }));
  return { folders, items, days, waypoints, people };
}
