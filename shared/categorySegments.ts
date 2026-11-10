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
  colorKey: string;
  name: string;
  mg: number;
}

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
        colorKey: folder?.colorKey ?? "other",
        name: folder?.name ?? "Other",
        mg,
      });
  }
  const segs = [...byFolder.values()];
  if (ungrouped > 0) segs.push({ colorKey: "other", name: "Other", mg: ungrouped });
  return segs.sort((a, b) => b.mg - a.mg);
}
