// A Markdown table, back in. Our own "Copy as Markdown" pasted into the import box
// made a list of 140 rows named "| --- | ---: | ---: |"; it is tested against the
// EXPORTER, so the reader and the writer can't drift apart without a failure here.
import { describe, expect, it } from "vitest";
import { item, snapshotFor, folder } from "./helpers/list";
import { listToMarkdown } from "../shared/exporters/markdown";
import { markdownTableRows } from "../shared/exporters/markdownImport";
import { csvToListData } from "../shared/exporters/csv";
import { computeTotals } from "../shared/weights";

const trip = () =>
  snapshotFor({
    shareCode: "",
    title: "Timberline",
    displayUnit: "lb",
    folders: [folder({ id: "f1", name: "Clothing" }), folder({ id: "f2", name: "Food", sortOrder: 1 })],
    people: [{ id: "p1", name: "Sam", colorKey: "green", sortOrder: 0 }],
    items: [
      item({ id: "a", name: "Tiger Wall UL2", brand: "Big Agnes", commonName: "Tent", unitWeightMg: 992_000, sortOrder: 0 }),
      item({ id: "b", name: "Dry bag", sortOrder: 1 }),
      item({ id: "b1", parentId: "b", name: "Socks", commonName: "Socks", unitWeightMg: 52_000, qty: 2, wornQty: 1, sortOrder: 0 }),
      item({ id: "b2", parentId: "b", name: "Beanie", unitWeightMg: 63_000, entryUnit: "oz", personId: "p1", sortOrder: 1 }),
      item({ id: "c", name: "Pot", unitWeightMg: 120_000, sortOrder: 2 }),
      item({ id: "c1", parentId: "c", name: "Stove", unitWeightMg: 45_000, sortOrder: 0 }),
      item({ id: "w", name: "Water", unitWeightMg: 2_000_000, sortOrder: 3 }),
      item({ id: "m1", folderId: "f2", name: "Monday", description: "Meals", sortOrder: 0 }),
      item({ id: "m1a", folderId: "f2", parentId: "m1", name: "Risotto", unitWeightMg: 213_000, sortOrder: 0 }),
      item({ id: "m2", folderId: "f2", name: "Monday", description: "Snacks", sortOrder: 1 }),
      item({ id: "m2a", folderId: "f2", parentId: "m2", name: "Bloks", unitWeightMg: 60_000, qty: 3, sortOrder: 0 }),
    ],
  });

describe("markdownTableRows", () => {
  it("leaves text with no table to the other readers", () => {
    expect(markdownTableRows("Tent 540 g\nQuilt 20 oz")).toBeNull();
    expect(markdownTableRows("Item Name,Weight\nTent,540")).toBeNull();
  });

  it("reads our own Markdown back into the list it was written from", () => {
    const back = csvToListData(listToMarkdown(trip()));
    expect(back.folders.map((f) => f.name)).toEqual(["Clothing", "Food"]);
    const row = (name: string) => back.items.find((i) => i.name === name)!;
    expect(row("Big Agnes Tiger Wall UL2").commonName).toBe("Tent");
    // a bare group holds nothing of its own; its rows come back inside it
    expect(row("Dry bag").unitWeightMg).toBe(0);
    expect(row("Socks").parentId).toBe(row("Dry bag").id);
    expect([row("Socks").qty, row("Socks").wornQty]).toEqual([2, 1]);
    expect(row("Beanie").entryUnit).toBe("oz");
    // the carrier comes back as a person
    expect(back.people?.map((p) => p.name)).toEqual(["Sam"]);
    // a group with weight of its own shows its total; what it holds itself is the rest
    expect(row("Pot").unitWeightMg).toBeCloseTo(120_000, -4);
    expect(row("Stove").parentId).toBe(row("Pot").id);
    // water's cell is its volume, never a count
    expect([row("Water").qty, row("Water").unitWeightMg]).toEqual([1, toMgLb(4.41)]);
    // two days of one name, told apart by their notes and by which rows follow them
    const mondays = back.items.filter((i) => i.name === "Monday");
    expect(mondays.map((m) => m.description)).toEqual(["Meals", "Snacks"]);
    expect(row("Bloks").parentId).toBe(mondays[1]!.id);
    expect(row("Bloks").qty).toBe(3);
    // a table rounds every figure to what it showed; the total lands within that
    const total = (l: { folders: never[] | typeof back.folders; items: typeof back.items }) => computeTotals(l as never).totalMg;
    expect(Math.abs(total(back) - total(trip()))).toBeLessThan(25_000);
  });

  it("brings the rows our table heads Unfiled back in no folder", () => {
    const list = trip();
    list.items.push(item({ id: "u", folderId: null, name: "Spoon", unitWeightMg: 14_000 }));
    const back = csvToListData(listToMarkdown(list));
    expect(back.folders.map((f) => f.name)).toEqual(["Clothing", "Food"]);
    expect(back.items.find((i) => i.name === "Spoon")!.folderId).toBeNull();
  });

  it("reads any other table by its own header, a heading naming the folder under it", () => {
    const md = ["## Shelter", "", "| Item | Weight (g) | Qty |", "|---|---:|---:|", "| Tent | 540 | 1 |", "| Stakes | 10 | 8 |"].join("\n");
    const back = csvToListData(md);
    expect(back.folders.map((f) => f.name)).toEqual(["Shelter"]);
    expect(back.items.map((i) => [i.name, i.qty, i.unitWeightMg])).toEqual([["Tent", 1, 540_000], ["Stakes", 8, 10_000]]);
  });
});

function toMgLb(lb: number): number {
  return Math.round(lb * 453_592.37);
}
