import { describe, expect, it } from "vitest";
import { applyOps, normalizeItem } from "../shared/ops";
import { listToJson, jsonToListImport } from "../shared/exporters/json";
import { csvToListData, listToCsv } from "../shared/exporters/csv";
import { diffListState, applyListDiff } from "../shared/snapshotDiff";
import { computeTotals } from "../shared/weights";
import { blankList } from "./helpers/list";
import type { Item } from "../shared/types";

const meal: Item = { id: "meal", folderId: "f1", name: "Pasta", qty: 6, unitWeightMg: 100_000,
  kcal: 400, classification: "consumable", sortOrder: 0 };
describe("trip-specific cooking choice", () => {
  it("persists a real boolean through patches, normalizing, backups and recovery without changing totals", () => {
    const list = blankList({ title: "Cooking", items: [{ ...meal }] });
    const before = structuredClone(list);
    const totals = computeTotals(list);
    applyOps(list, [{ t: "updateItem", id: "meal", patch: { needsCooking: true } }]);
    expect(normalizeItem(list.items[0]!).needsCooking).toBe(true);
    expect(jsonToListImport(listToJson(list))?.data.items[0]!.needsCooking).toBe(true);
    expect(csvToListData(listToCsv(list)).items[0]!.needsCooking).toBe(true);
    expect(applyListDiff(before, diffListState(before, list)).items[0]!.needsCooking).toBe(true);
    expect(computeTotals(list)).toEqual(totals);
    applyOps(list, [{ t: "updateItem", id: "meal", patch: { needsCooking: false } }]);
    expect(list.items[0]!.needsCooking).toBeUndefined();
    expect(jsonToListImport(listToJson(list))?.data.items[0]!.needsCooking).toBeUndefined();
    expect(computeTotals(list)).toEqual(totals);
  });
  it("does not infer true from old backups or truthy malformed inputs", () => {
    for (const value of [undefined, null, false, "true", "false", 1, {}]) {
      expect(normalizeItem({ ...meal, needsCooking: value as boolean }).needsCooking).toBeUndefined();
    }
    const list = blankList({ items: [{ ...meal, needsCooking: true }] });
    applyOps(list, [{ t: "updateItem", id: "meal", patch: { needsCooking: "false" as unknown as boolean } }]);
    expect(list.items[0]!.needsCooking).toBe(true);
  });
});
