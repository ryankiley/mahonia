import { describe, expect, it } from "vitest";
import { carryHours, dryCarries, longestCarryForDay } from "../shared/dryCarry";
import { dayRanges } from "../shared/tripPlan";

// A 40 km route with water at 8, 22.2 and 30 km; three days of 15, 15 and 10 km. The
// long carry is 8 → 22.2 km (14.2 km) and it straddles the first night: day 1 ends at
// 15 km with 7.2 km of it still to walk.
const ROUTE_M = 40_000;
const PINS = [
  { alongM: 22_200 },
  { alongM: 8_000, label: "Zigzag spring" },
  { alongM: 30_000, label: "Creek" },
];
const DAYS = [15_000, 15_000, 10_000];

describe("dryCarries", () => {
  it("is the stretches between the trailhead, each water pin in route order, and the finish", () => {
    const c = dryCarries(PINS, ROUTE_M);
    expect(c.map((x) => [x.fromM, x.toM])).toEqual([[0, 8_000], [8_000, 22_200], [22_200, 30_000], [30_000, 40_000]]);
    expect(c[0]!.from.kind).toBe("trailhead");
    expect(c[1]!.from).toEqual({ alongM: 8_000, label: "Zigzag spring", kind: "water" });
    expect(c[1]!.to.label).toBeUndefined();
    expect(c[3]!.to.kind).toBe("finish");
  });

  it("is nothing without a water pin: the whole route is not a carry", () => {
    expect(dryCarries([], ROUTE_M)).toEqual([]);
    expect(dryCarries([{ alongM: 8_000 }], 0)).toEqual([]);
  });

  it("ignores a pin off the route and folds one that sits on an end into it", () => {
    const c = dryCarries([{ alongM: -5 }, { alongM: 41_000 }, { alongM: 2, label: "Tap at the car park" }, { alongM: 20_000 }], ROUTE_M);
    // the tap 2 m from the trailhead IS the trailhead, still called the trailhead
    expect(c.map((x) => [x.fromM, x.toM])).toEqual([[0, 20_000], [20_000, 40_000]]);
    expect(c[0]!.from.kind).toBe("trailhead");
  });

  it("keeps the named pin when two mark the same place", () => {
    const c = dryCarries([{ alongM: 10_000 }, { alongM: 10_002, label: "Spring" }], ROUTE_M);
    expect(c).toHaveLength(2);
    expect(c[1]!.from).toMatchObject({ alongM: 10_000, label: "Spring" });
  });
});

describe("longestCarryForDay", () => {
  const carries = dryCarries(PINS, ROUTE_M);
  const ranges = dayRanges(DAYS);

  it("is the longest carry the day walks any part of, in full, night or no night", () => {
    // day 1 walks 0–15: the 14.2 km carry from the spring, not the 7 km it walks of it
    expect(longestCarryForDay(carries, ranges[0]!)).toMatchObject({ fromM: 8_000, toM: 22_200 });
    // day 2 walks 15–30: the same carry, still the longest it touches
    expect(longestCarryForDay(carries, ranges[1]!)).toMatchObject({ fromM: 8_000, toM: 22_200 });
    // day 3 walks 30–40: the carry to the finish, which starts exactly where the day does
    expect(longestCarryForDay(carries, ranges[2]!)).toMatchObject({ fromM: 30_000, toM: 40_000 });
  });

  it("does not credit a day with a carry that ends where the day begins", () => {
    // a day starting at 30 km never walks the 22.2–30 carry
    expect(longestCarryForDay(carries, { fromM: 30_000, toM: 40_000 })!.fromM).toBe(30_000);
  });

  it("is null for a day with no ground, and with no carries", () => {
    expect(longestCarryForDay(carries, { fromM: 15_000, toM: 15_000 })).toBeNull();
    expect(longestCarryForDay([], ranges[0]!)).toBeNull();
  });
});

describe("carryHours", () => {
  const ranges = dayRanges(DAYS);
  const hours = [5, 6, 4]; // 15 km at 3 km/h, 15 km at 2.5 km/h, 10 km at 2.5 km/h

  it("sums each day's share of the carry at that day's pace", () => {
    // 8–22.2: 7 km of day 1 (7/15 × 5 h) + 7.2 km of day 2 (7.2/15 × 6 h)
    expect(carryHours({ fromM: 8_000, toM: 22_200 }, ranges, hours)).toBeCloseTo(7 / 3 + 2.88, 6);
    // 30–40 lies wholly in day 3
    expect(carryHours({ fromM: 30_000, toM: 40_000 }, ranges, hours)).toBeCloseTo(4, 6);
  });

  it("declines when part of the carry has no estimate, rather than answering for the part", () => {
    // day 2 has no estimate
    expect(carryHours({ fromM: 8_000, toM: 22_200 }, ranges, [5, undefined, 4])).toBeUndefined();
    // the carry runs into the tail no day owns
    expect(carryHours({ fromM: 30_000, toM: 45_000 }, ranges, hours)).toBeUndefined();
    expect(carryHours({ fromM: 8_000, toM: 8_000 }, ranges, hours)).toBeUndefined();
  });

  it("tolerates the metre the two sums can disagree by", () => {
    expect(carryHours({ fromM: 30_000, toM: 40_000.8 }, ranges, hours)).toBeCloseTo(4, 3);
  });
});
