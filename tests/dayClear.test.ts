import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyOps, type Op } from "~~/shared/ops";
import type { ListState } from "~~/shared/types";

/**
 * Clearing a day's figures has to survive the WIRE, not just the reducer.
 *
 * The bug this pins was invisible to a normal reducer test: `{ distanceM: undefined }`
 * cleared the value perfectly when applyOps was called directly, and vanished the moment
 * the same op went through JSON — because JSON.stringify drops undefined keys, so the
 * `"distanceM" in patch` test the reducer relies on was false by the time the server ran
 * it. The clear applied optimistically and the next autosave echo put the old value back.
 *
 * So every case here round-trips the op through JSON first. A test that skips that step
 * passes against the broken code.
 */
const wire = (op: Op): Op => JSON.parse(JSON.stringify(op)) as Op;

const listWith = (day: Partial<{ distanceM: number; ascentM: number; descentM: number }>): ListState =>
  ({
    title: "t",
    displayUnit: "g",
    folders: [],
    items: [],
    days: [{ id: "d1", sortOrder: 0, ...day }],
  }) as unknown as ListState;

describe("clearing a day's figures reaches the reducer through JSON", () => {
  it("clears a distance", () => {
    const state = listWith({ distanceM: 17_703 });
    applyOps(state, [wire({ t: "updateDay", id: "d1", patch: { distanceM: "" } })]);
    expect(state.days?.[0]?.distanceM).toBeUndefined();
  });

  it("clears a climb", () => {
    const state = listWith({ ascentM: 610 });
    applyOps(state, [wire({ t: "updateDay", id: "d1", patch: { ascentM: "" } })]);
    expect(state.days?.[0]?.ascentM).toBeUndefined();
  });

  it("clears one figure without touching the others", () => {
    const state = listWith({ distanceM: 17_703, ascentM: 610 });
    applyOps(state, [wire({ t: "updateDay", id: "d1", patch: { distanceM: "" } })]);
    expect(state.days?.[0]?.distanceM).toBeUndefined();
    expect(state.days?.[0]?.ascentM).toBe(610);
  });

  it("still sets a real figure", () => {
    const state = listWith({});
    applyOps(state, [wire({ t: "updateDay", id: "d1", patch: { distanceM: 16_093 } })]);
    expect(state.days?.[0]?.distanceM).toBe(16_093);
  });

  // The negative control: this is what the app used to send, and it is why the bug was
  // invisible. If a future change makes THIS work too, the sentinel has become optional —
  // fine — but the assertion should be updated deliberately rather than quietly passing.
  it("undefined does NOT survive the wire, which is the whole reason for the sentinel", () => {
    const op = { t: "updateDay", id: "d1", patch: { distanceM: undefined } } as unknown as Op;
    expect("distanceM" in (wire(op) as { patch: object }).patch).toBe(false);
  });
});

/**
 * The reducer half above passes against the BROKEN code, and that is worth saying out loud:
 * cleanDayPatch always understood "" (cleanDayMetres parses it to NaN and returns
 * undefined), and `"distanceM" in patch` is true for "". Nothing server-side was wrong.
 *
 * The defect was entirely on the client — the panel sent `undefined`, which never arrived.
 * So the guard has to be on what the panel SENDS, or the fix can be reverted without a
 * single test noticing.
 */
describe("the planning panel sends the clear sentinel, not undefined", () => {
  const src = readFileSync(new URL("../app/components/TrailPlanPanel.vue", import.meta.url), "utf8");

  it("commits a cleared distance as \"\"", () => {
    expect(src).toMatch(/distanceM:\s*raw\s*\?[^;]*\?\?\s*""\s*\)\s*:\s*""/);
  });

  it("commits a cleared climb as \"\"", () => {
    expect(src).toMatch(/ascentM:\s*raw\s*\?[^;]*\?\?\s*""\s*\)\s*:\s*""/);
  });
});
