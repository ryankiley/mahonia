import { describe, expect, it } from "vitest";
import { KCAL_PER_DAY_GENEROUS, KCAL_PER_DAY_LIGHT, foodPlan, tripDays } from "../shared/foodPlan";

const totals = (kcalTotal: number) => ({ kcalTotal, hasKcal: kcalTotal > 0 });
const meta = (over: Partial<Parameters<typeof foodPlan>[1]> = {}) => ({
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
