import { describe, expect, it } from "vitest";
import { UNASSIGNED } from "../shared/people";
import { walkerLoad } from "../shared/tripLoad";
import type { Item, Person } from "../shared/types";
import { folder, item, snapshotFor } from "./helpers/list";

const crew: Person[] = [
  { id: "sam", name: "Sam", sortOrder: 0 },
  { id: "alex", name: "Alex", sortOrder: 1 },
  { id: "jo", name: "Jo", sortOrder: 2 },
];
const kg = (n: number) => n * 1_000_000;
const gearRow = (id: string, mg: number, personId?: string): Item => item({ id, unitWeightMg: mg, personId });
const foodRow = (id: string, mg: number, personId?: string): Item =>
  item({ id, folderId: "food", name: `Food ${id}`, unitWeightMg: mg, personId });
const waterRow = (id: string, mg: number, personId?: string): Item =>
  item({ id, folderId: "food", name: "Water", unitWeightMg: mg, personId });
const list = (items: Item[], people?: Person[]) =>
  snapshotFor({
    folders: [folder(), folder({ id: "food", name: "Food", defaultClassification: "consumable", sortOrder: 1 })],
    items,
    people,
  });

// three 9 kg packs: 7 kg of gear and 2 kg of food each
const threePacks = list(
  crew.flatMap((p) => [gearRow(`g-${p.id}`, kg(7), p.id), foodRow(`f-${p.id}`, kg(2), p.id)]),
  crew,
);

describe("walkerLoad: the pack the planning view walks with", () => {
  it("walks with the average pack in the Everyone view of a group, not all of them", () => {
    // the bug: one hiker under 27 kg
    expect(walkerLoad(threePacks, null)).toEqual({ carriedMg: kg(9), burnableMg: kg(2), people: 3 });
  });

  it("walks with one person's own pack when their chip is picked", () => {
    const uneven = list(
      [gearRow("tent", kg(2), "sam"), gearRow("pack", kg(1), "sam"), foodRow("f", kg(3), "alex")],
      crew.slice(0, 2),
    );
    expect(walkerLoad(uneven, "sam")).toEqual({ carriedMg: kg(3), burnableMg: 0, people: 1 });
    expect(walkerLoad(uneven, "alex")).toEqual({ carriedMg: kg(3), burnableMg: kg(3), people: 1 });
  });

  it("plans Unassigned as Everyone: nobody walks with only the unclaimed rows", () => {
    expect(walkerLoad(threePacks, UNASSIGNED)).toEqual(walkerLoad(threePacks, null));
  });

  it("counts water as carried but never as eaten", () => {
    const wet = list([foodRow("f", kg(2), "sam"), waterRow("w", kg(1), "sam")], crew.slice(0, 1));
    expect(walkerLoad(wet, null)).toEqual({ carriedMg: kg(3), burnableMg: kg(2), people: 1 });
    expect(walkerLoad(wet, "sam")).toEqual({ carriedMg: kg(3), burnableMg: kg(2), people: 1 });
  });

  it("leaves a list with one person or none as one hiker's", () => {
    const solo = list([gearRow("g", kg(8)), foodRow("f", kg(2))]);
    expect(walkerLoad(solo, null)).toEqual({ carriedMg: kg(10), burnableMg: kg(2), people: 1 });
    expect(walkerLoad({ ...solo, people: crew.slice(0, 1) }, null).people).toBe(1);
  });

  it("leaves worn weight out of the pack", () => {
    const worn = list(
      [gearRow("g", kg(6), "sam"), item({ id: "boots", unitWeightMg: kg(1), classification: "worn", personId: "sam" })],
      crew.slice(0, 1),
    );
    expect(walkerLoad(worn, "sam").carriedMg).toBe(kg(6));
  });
});
