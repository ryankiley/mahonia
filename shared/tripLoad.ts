// The pack the planning view walks with.
//
// The burn model (shared/tripPlan.ts) estimates ONE walker: one body, one pack. A list
// that names several people holds several packs, and handing the model all of them made
// a three-person trip plan one hiker hauling 27 kg: slower days, a bigger burn and a
// "Carried" chip three times what anyone shoulders. So the planning view walks with the
// pack the person chips point at, the same chips and the same rule as the totals bar's
// food per day (shared/foodPlan.ts):
//
// - a person's chip: what that person carries, their own food burning down as they go;
// - Everyone, on a list naming two or more: the average pack, the whole list shared
//   evenly, which is all a figure for "a person" can honestly be without picking one;
// - Unassigned: nobody walks with only the unclaimed rows, so it plans as Everyone.
//
// A list with one person or none is one hiker's, as it always was.

import { filterItemsForPerson, UNASSIGNED, type PersonSelection } from "./people";
import type { ListSnapshot } from "./types";
import { isWaterName } from "./water";
import { computeTotals, effectiveClassification, lineMg } from "./weights";

export interface WalkerLoad {
  /** base + consumable on this walker's back at the trailhead, mg */
  carriedMg: number;
  /** the part of it they eat along the way: consumables less water, which refills */
  burnableMg: number;
  /** how many people the list's packs are averaged across; 1 for one person's own */
  people: number;
}

export function walkerLoad(
  list: Pick<ListSnapshot, "items" | "folders" | "people">,
  selection: PersonSelection,
): WalkerLoad {
  const own = selection && selection !== UNASSIGNED ? selection : null;
  const items = own ? filterItemsForPerson(list.items, own) : list.items;
  const totals = computeTotals({ folders: list.folders, items });
  const waterMg = items
    .filter((item) => isWaterName(item.name))
    .filter((item) => effectiveClassification(item, list.folders) === "consumable")
    .reduce((sum, item) => sum + lineMg(item), 0);
  const named = list.people?.length ?? 0;
  const people = !own && named > 1 ? named : 1;
  return {
    carriedMg: Math.round(totals.carriedMg / people),
    burnableMg: Math.round(Math.max(0, totals.consumableMg - waterMg) / people),
    people,
  };
}
