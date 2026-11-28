import { describe, expect, it } from "vitest";
import type { Op } from "../shared/ops";
import { canonical, fixtures, ruleVectors } from "../scripts/iosFixtures";

// Every op kind there is. A Record over Op["t"], so the compiler refuses a new op
// until it is listed here, and the test below then refuses it until a scenario
// replays it. People went three months unported because nothing asked.
const OP_KINDS: Record<Op["t"], true> = {
  addItem: true,
  updateItem: true,
  removeItem: true,
  moveItem: true,
  addFolder: true,
  updateFolder: true,
  removeFolder: true,
  addDay: true,
  updateDay: true,
  removeDay: true,
  addWaypoint: true,
  updateWaypoint: true,
  removeWaypoint: true,
  addPerson: true,
  updatePerson: true,
  removePerson: true,
  setMeta: true,
};

describe("the iOS port's fixtures", () => {
  it("replay every kind of op at least once", () => {
    const replayed = new Set<string>(fixtures.flatMap((f) => f.ops.map((op) => op.t)));
    expect(Object.keys(OP_KINDS).filter((t) => !replayed.has(t))).toEqual([]);
  });

  it("name each scenario once, since the name is its file", () => {
    const names = fixtures.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // A vector is compared byte for byte on the other side, so it has to come out the
  // same every time: a copy and a restore mint ids, and one left in would differ per run.
  it("write the same rule vectors twice, each with cases in it", () => {
    const vectors = ruleVectors();
    expect(Object.entries(vectors).filter(([, v]) => v.cases.length === 0)).toEqual([]);
    expect(canonical(ruleVectors())).toBe(canonical(vectors));
  });
});
