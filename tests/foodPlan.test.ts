import { describe, expect, it } from "vitest";
import { KCAL_PER_DAY_GENEROUS, KCAL_PER_DAY_LIGHT, foodHeadcount, foodPlan, tripDays } from "../shared/foodPlan";
import { UNASSIGNED } from "../shared/people";
import type { Unit } from "../shared/types";

const totals = (kcalTotal: number) => ({ kcalTotal, hasKcal: kcalTotal > 0 });
// `displayUnit` isn't read by foodPlan — it rides along because some callers build a
// whole ListMeta from this — so the override type is the plan's slice plus that.
const meta = (
  over: Partial<Parameters<typeof foodPlan>[1]> & { displayUnit?: Unit } = {},
) => ({
  displayUnit: "g" as const,
  ...over,
});

describe("tripDays", () => {
  it("counts both ends — the days you eat on, not the nights", () => {
    expect(tripDays("2026-08-04", "2026-08-06")).toBe(3);
    expect(tripDays("2026-08-04", "2026-08-04")).toBe(1);
  });

  it("spans a month and a year boundary", () => {
    expect(tripDays("2026-08-30", "2026-09-02")).toBe(4);
    expect(tripDays("2026-12-31", "2027-01-01")).toBe(2);
  });

  it("is unaffected by a DST boundary — these are calendar dates, not instants", () => {
    // US DST ends 2026-11-01; a local-midnight Date would make this span 25 hours
    // and round to the wrong day count
    expect(tripDays("2026-10-31", "2026-11-02")).toBe(3);
  });

  it("needs both ends, in order", () => {
    expect(tripDays("2026-08-04", undefined)).toBeNull();
    expect(tripDays(undefined, "2026-08-06")).toBeNull();
    expect(tripDays(undefined, undefined)).toBeNull();
    expect(tripDays("2026-08-06", "2026-08-04")).toBeNull();
    expect(tripDays("not-a-date", "2026-08-06")).toBeNull();
  });
});

describe("foodPlan", () => {
  it("divides the calories by the days", () => {
    const plan = foodPlan(totals(9000), meta({ startDate: "2026-08-04", endDate: "2026-08-06" }));
    expect(plan).toMatchObject({ days: 3, kcalPerDay: 3000, reading: "typical" });
  });

  it("stays silent without calories — the gate that keeps it off most lists", () => {
    expect(foodPlan(totals(0), meta({ startDate: "2026-08-04", endDate: "2026-08-06" }))).toBeNull();
  });

  it("stays silent without dates — kcal alone is the number the totals bar already shows", () => {
    expect(foodPlan(totals(9000), meta())).toBeNull();
    expect(foodPlan(totals(9000), meta({ startDate: "2026-08-04" }))).toBeNull();
  });

  it("reads the band at its edges", () => {
    const forDay = (kcal: number) =>
      foodPlan(totals(kcal), meta({ startDate: "2026-08-04", endDate: "2026-08-04" }))?.reading;
    expect(forDay(KCAL_PER_DAY_LIGHT - 1)).toBe("light");
    expect(forDay(KCAL_PER_DAY_LIGHT)).toBe("typical");
    expect(forDay(KCAL_PER_DAY_GENEROUS)).toBe("typical");
    expect(forDay(KCAL_PER_DAY_GENEROUS + 1)).toBe("generous");
  });

  it("catches the case the feature exists for: a day of food for a five-day trip", () => {
    const plan = foodPlan(totals(3000), meta({ startDate: "2026-08-04", endDate: "2026-08-08" }));
    expect(plan).toMatchObject({ days: 5, kcalPerDay: 600, reading: "light" });
  });

  it("spreads a distance over the days, in the unit the list reads in", () => {
    // miles is the default now, whatever the list weighs gear in
    const byDefault = foodPlan(
      totals(9000),
      meta({ startDate: "2026-08-04", endDate: "2026-08-06", trailDistanceM: 30_000 }),
    );
    expect(byDefault?.perDayDistance).toBe("6.2 mi");

    const metric = foodPlan(
      totals(9000),
      meta({
        startDate: "2026-08-04",
        endDate: "2026-08-06",
        trailDistanceM: 30_000,
        trailDistanceUnit: "km",
      }),
    );
    expect(metric?.perDayDistance).toBe("10 km");
  });

  it("honours an explicit distance unit over the one the weight unit implies", () => {
    const plan = foodPlan(
      totals(9000),
      meta({
        startDate: "2026-08-04",
        endDate: "2026-08-06",
        trailDistanceM: 30_000,
        displayUnit: "g", // metric list…
        trailDistanceUnit: "mi", // …whose owner reads distance in miles
      }),
    );
    expect(plan?.perDayDistance).toBe("6.2 mi");
  });

  it("has no per-day distance when no distance was entered", () => {
    const plan = foodPlan(totals(9000), meta({ startDate: "2026-08-04", endDate: "2026-08-06" }));
    expect(plan?.perDayDistance).toBeNull();
  });
});

describe("food for a group", () => {
  const crew = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, sortOrder: i }));
  const trip = meta({ startDate: "2026-08-04", endDate: "2026-08-06" });

  it("splits the whole trip's food across everyone on it", () => {
    // three people's normal food: the bug read this as 9,000 a day, "generous"
    const plan = foodPlan(totals(27_000), trip, foodHeadcount(crew(3), null) ?? 1);
    expect(plan).toMatchObject({ days: 3, people: 3, kcalPerDay: 3000, reading: "typical" });
  });

  it("catches a group short of food that one person's band would have passed", () => {
    expect(foodPlan(totals(9000), trip, 3)).toMatchObject({ kcalPerDay: 1000, reading: "light" });
  });

  it("counts everyone only in the Everyone view of a list with two or more people", () => {
    expect(foodHeadcount(crew(3), null)).toBe(3);
    expect(foodHeadcount(crew(3), "")).toBe(3); // "everyone" by the same test the rows use
    expect(foodHeadcount(crew(3), "p1")).toBe(1); // what that person carries
    expect(foodHeadcount(crew(1), null)).toBe(1);
    expect(foodHeadcount([], null)).toBe(1);
    expect(foodHeadcount(undefined, null)).toBe(1);
  });

  it("gives Unassigned no reading, so the same rows can't read two ways", () => {
    // 27,000 kcal of unclaimed group food: 3,000 a person in the Everyone view; read as
    // one person's under Unassigned it would be 9,000 a day, "generous"
    expect(foodHeadcount(crew(3), UNASSIGNED)).toBeNull();
    expect(foodHeadcount(crew(1), UNASSIGNED)).toBeNull();
  });

  it("reads a nonsense headcount as one hiker", () => {
    for (const n of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(foodPlan(totals(9000), trip, n)).toMatchObject({ people: 1, kcalPerDay: 3000 });
    }
  });
});
