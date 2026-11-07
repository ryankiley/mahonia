import { describe, expect, it } from "vitest";
import { jsonToListImport, listToJson } from "~~/shared/exporters/json";
import { applyOps, MAX_NOTE_LEN, normalizeDay, type Op } from "~~/shared/ops";
import type { ListMeta, ListData, ListState } from "~~/shared/types";

// through JSON first, as every op travels (see dayClear.test.ts for why that matters)
const wire = (op: Op): Op => JSON.parse(JSON.stringify(op)) as Op;

const list = (): ListState =>
  ({ title: "t", displayUnit: "g", folders: [], items: [], days: [{ id: "d1", sortOrder: 0 }] }) as unknown as ListState;

describe("a note on a day", () => {
  it("is set, trimmed and capped by updateDay", () => {
    const state = list();
    applyOps(state, [wire({ t: "updateDay", id: "d1", patch: { note: "  Resupply at Reds, shuttle at 8 " } })]);
    expect(state.days?.[0]?.note).toBe("Resupply at Reds, shuttle at 8");
    applyOps(state, [wire({ t: "updateDay", id: "d1", patch: { note: "x".repeat(MAX_NOTE_LEN + 50) } })]);
    expect(state.days?.[0]?.note).toHaveLength(MAX_NOTE_LEN);
  });

  it("clears on an empty string, and is left alone by a patch that doesn't name it", () => {
    const state = list();
    applyOps(state, [wire({ t: "updateDay", id: "d1", patch: { note: "Zero day in town" } })]);
    applyOps(state, [wire({ t: "updateDay", id: "d1", patch: { distanceM: 12_000 } })]);
    expect(state.days?.[0]?.note).toBe("Zero day in town");
    applyOps(state, [wire({ t: "updateDay", id: "d1", patch: { note: "" } })]);
    expect(state.days?.[0]).not.toHaveProperty("note", expect.anything());
  });

  it("is stored absent rather than blank when a day arrives with whitespace for one", () => {
    expect(normalizeDay({ id: "d", sortOrder: 0, note: "   " }).note).toBeUndefined();
    expect(normalizeDay({ id: "d", sortOrder: 0, note: "Permit pickup" }).note).toBe("Permit pickup");
  });

  it("rides the JSON backup out and back in", () => {
    const backup = listToJson({
      title: "JMT",
      displayUnit: "g",
      folders: [],
      items: [],
      days: [{ id: "d1", sortOrder: 0, label: "Reds Meadow", note: "Resupply at Reds, shuttle at 8" }],
    } as ListMeta & ListData);
    const back = jsonToListImport(backup);
    expect(back?.data.days?.[0]).toMatchObject({ label: "Reds Meadow", note: "Resupply at Reds, shuttle at 8" });
  });
});
