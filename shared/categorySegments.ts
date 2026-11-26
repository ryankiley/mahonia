// What a list's weight is made of, by folder: CategoryBar's data. Pure, so it
// unit-tests without Nuxt.

import { lineMg } from "./weights";
import type { ListData } from "./types";

// ---------------------------------------------------------------------------
// Category segments — the ONE colour in the app (CategoryBar's data viz). Sums
// each folder's line weight, heaviest first; ungrouped weight rolls into
// "Other". Empty / weightless lists return [] (no bar — weight is optional).
// ---------------------------------------------------------------------------
interface SparkSegment {
  // the folder's id ("" for the ungrouped roll-up): what a segment IS from one
  // edit to the next. The order isn't (it is by weight, so an edit can change it),
  // and the bar needs to know which segment grew to draw it growing.
  id: string;
  colorKey: string;
  name: string;
  mg: number;
}

// can't be a folder's: an item with an empty folderId is counted as ungrouped below
const UNGROUPED_ID = "";

export function categorySegments(data: ListData): SparkSegment[] {
  const byFolder = new Map<string, SparkSegment>();
  // one lookup table instead of a folders.find() per item — this recomputes on
  // every edit (CategoryBar), so keep it O(items + folders)
  const folderById = new Map((data.folders ?? []).map((f) => [f.id, f]));
  let ungrouped = 0;
  for (const item of data.items ?? []) {
    const mg = lineMg(item);
    if (mg <= 0) continue;
    if (!item.folderId) {
      ungrouped += mg;
      continue;
    }
    const folder = folderById.get(item.folderId);
    const existing = byFolder.get(item.folderId);
    if (existing) existing.mg += mg;
    else
      byFolder.set(item.folderId, {
        id: item.folderId,
        colorKey: folder?.colorKey ?? "other",
        name: folder?.name ?? "Other",
        mg,
      });
  }
  const segs = [...byFolder.values()];
  if (ungrouped > 0) segs.push({ id: UNGROUPED_ID, colorKey: "other", name: "Other", mg: ungrouped });
  return segs.sort((a, b) => b.mg - a.mg);
}

// Which segments changed places, going from one order of ids to the next: the fewest
// that have to be lifted out and put back for `before` to become `after`, ids that are
// in only one of the two left aside (those arrived or left, they didn't move). So when
// one folder climbs past three others it is the one that moved, not the three.
// The rest is a longest increasing subsequence, by the plain quadratic method: a list
// has a handful of folders.
export function displacedIds(before: readonly string[], after: readonly string[]): string[] {
  const was = new Map(before.map((id, i) => [id, i]));
  const ids = after.filter((id) => was.has(id));
  const at = ids.map((id) => was.get(id)!);
  // run[i]: the longest in-order run ending at i; from[i]: the member before it
  const run = at.map(() => 1);
  const from = at.map(() => -1);
  let end = -1;
  for (let i = 0; i < at.length; i++) {
    for (let j = 0; j < i; j++) {
      if (at[j]! < at[i]! && run[j]! + 1 > run[i]!) {
        run[i] = run[j]! + 1;
        from[i] = j;
      }
    }
    if (end < 0 || run[i]! > run[end]!) end = i;
  }
  const stayed = new Set<number>();
  for (let i = end; i >= 0; i = from[i]!) stayed.add(i);
  return ids.filter((_, i) => !stayed.has(i));
}
