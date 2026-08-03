import { describe, expect, it } from "vitest";
import { summarizeOps } from "../shared/changeSummary";
import type { Op } from "../shared/ops";

const item = (id: string) => ({ id, folderId: null, name: id, unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 });

describe("summarizeOps", () => {
  it("names the structural change first", () => {
    expect(summarizeOps([{ t: "addItem", item: item("a") }] as Op[])).toBe("Added 1 item");
    expect(summarizeOps([{ t: "addItem", item: item("a") }, { t: "addItem", item: item("b") }] as Op[]))
      .toBe("Added 2 items");
    expect(summarizeOps([{ t: "removeItem", id: "a" }, { t: "removeItem", id: "b" }] as Op[]))
      .toBe("Removed 2 items");
  });

  it("says both when a batch adds and removes", () => {
    expect(summarizeOps([{ t: "addItem", item: item("a") }, { t: "removeItem", id: "b" }] as Op[]))
      .toBe("Added 1, removed 1");
  });

  it("tells a rename from a re-weigh from a reclassify", () => {
    expect(summarizeOps([{ t: "updateItem", id: "a", patch: { name: "Tent" } }] as Op[]))
      .toBe("Renamed 1 item");
    expect(summarizeOps([{ t: "updateItem", id: "a", patch: { unitWeightMg: 900 } }] as Op[]))
      .toBe("Changed 1 weight");
    expect(summarizeOps([{ t: "updateItem", id: "a", patch: { classification: "worn" } }] as Op[]))
      .toBe("Reclassified 1 item");
  });

  it("counts a unit change as a weight change — it re-expresses the same number", () => {
    expect(summarizeOps([{ t: "updateItem", id: "a", patch: { entryUnit: "oz" } }] as Op[]))
      .toBe("Changed 1 weight");
  });

  it("gives packing its own phrase rather than calling it an edit", () => {
    expect(summarizeOps([
      { t: "updateItem", id: "a", patch: { packed: true } },
      { t: "updateItem", id: "b", patch: { packed: true } },
    ] as Op[])).toBe("Checked off 2 items");
  });

  it("falls back to a COUNT for a genuine mixture, never to a bare 'Edited'", () => {
    const out = summarizeOps([
      { t: "updateItem", id: "a", patch: { name: "Tent" } },
      { t: "updateItem", id: "b", patch: { unitWeightMg: 900 } },
    ] as Op[]);
    expect(out).toBe("Edited 2 items");
  });

  it("returns empty for an empty batch, so the caller keeps its own default", () => {
    expect(summarizeOps([])).toBe("");
  });

  it("stays short enough to be a label", () => {
    const many = Array.from({ length: 999 }, (_, i) => ({ t: "addItem", item: item(`i${i}`) })) as Op[];
    expect(summarizeOps(many).length).toBeLessThan(40);
  });
});
