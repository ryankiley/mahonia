import { describe, expect, it } from "vitest";
import {
  burnDownMg,
  dayLegs,
  estimateDay,
  restingKcal,
  toblerSpeedMs,
  walkingKcal,
  walkingVo2,
} from "../shared/tripPlan";

// One MET is 3.5 mL/kg/min by convention — the unit that lets an oxygen figure be
// checked against published activity values instead of against itself.
const METS = (vo2: number) => vo2 / 3.5;

// The independent reference: the ACSM walking equation, which is open and widely
// published. It reads high (the 2021 field study measured it at +13%), so it's used
// here for DIRECTION and rough magnitude, never as ground truth.
const acsmVo2 = (speedMs: number, gradeFrac: number) =>
  0.1 * (speedMs * 60) + 1.8 * (speedMs * 60) * gradeFrac + 3.5;

describe("walkingVo2 — the two transcription ambiguities, pinned", () => {
  // The source table prints `(w+l)wt(…)`. VO2 is PER KILOGRAM, so the load term has to
  // be the ratio (w+l)/w. The product form comes out an order of magnitude high, and
  // this is the test that says so.
  it("level walking lands at ~3.2 METs, which only the ratio form does", () => {
    const vo2 = walkingVo2({ speedMs: 1.34, gradePct: 0, bodyKg: 70, terrain: "paved" });
    expect(METS(vo2)).toBeGreaterThan(2.9);
    expect(METS(vo2)).toBeLessThan(3.5);
    // the product form would give (70 × 8.06) + 3.05 ≈ 567 mL/kg/min — 162 METs
    expect(vo2).toBeLessThan(20);
  });

  // The source says grade is "expressed as decimal". It is not — it is PERCENT. As a
  // decimal the grade term all but vanishes and a climb comes out CHEAPER than the flat,
  // which is the failure this test exists to catch.
  it("a 10% climb costs meaningfully more than the flat", () => {
    const flat = walkingVo2({ speedMs: 1.0, gradePct: 0, bodyKg: 70 });
    const climb = walkingVo2({ speedMs: 1.0, gradePct: 10, bodyKg: 70 });
    expect(climb).toBeGreaterThan(flat * 1.5);
  });

  it("cost rises monotonically with grade", () => {
    const at = (g: number) => walkingVo2({ speedMs: 1.0, gradePct: g, bodyKg: 70 });
    expect(at(0)).toBeLessThan(at(3));
    expect(at(3)).toBeLessThan(at(6));
    expect(at(6)).toBeLessThan(at(9));
  });

  it("tracks the ACSM reference in direction, and sits below it as measured", () => {
    // ACSM runs high; minimum mechanics should be under it across the range, not over
    for (const [deg, speedMs] of [[0, 1.34], [3, 1.2], [6, 1.1], [9, 1.0]] as const) {
      const frac = Math.tan((deg * Math.PI) / 180);
      const ours = walkingVo2({ speedMs, gradePct: frac * 100, bodyKg: 70, terrain: "paved" });
      const acsm = acsmVo2(speedMs, frac);
      expect(ours).toBeLessThanOrEqual(acsm * 1.05);
      expect(ours).toBeGreaterThan(acsm * 0.7);
    }
  });
});

describe("walkingVo2 — load and terrain", () => {
  it("carrying a pack costs more", () => {
    const bare = walkingVo2({ speedMs: 1.2, gradePct: 5, bodyKg: 70, loadKg: 0 });
    const loaded = walkingVo2({ speedMs: 1.2, gradePct: 5, bodyKg: 70, loadKg: 14 });
    expect(loaded).toBeGreaterThan(bare);
    // 14 kg on a 70 kg walker is +20% gravitational load; the cost above the 3.05
    // resting intercept should rise by about that
    expect((loaded - 3.05) / (bare - 3.05)).toBeCloseTo(1.2, 1);
  });

  it("rougher ground costs more", () => {
    const base = { speedMs: 1.2, gradePct: 0, bodyKg: 70 } as const;
    expect(walkingVo2({ ...base, terrain: "trail" })).toBeGreaterThan(
      walkingVo2({ ...base, terrain: "paved" }),
    );
    expect(walkingVo2({ ...base, terrain: "rough" })).toBeGreaterThan(
      walkingVo2({ ...base, terrain: "trail" }),
    );
  });

  it("declines rather than inventing a number for nonsense inputs", () => {
    expect(walkingVo2({ speedMs: 0, gradePct: 5, bodyKg: 70 })).toBe(0);
    expect(walkingVo2({ speedMs: 1.2, gradePct: 5, bodyKg: 0 })).toBe(0);
  });
});

describe("walkingVo2 — descent", () => {
  it("is cheaper than the flat, but not free", () => {
    const flat = walkingVo2({ speedMs: 1.2, gradePct: 0, bodyKg: 70 });
    const down = walkingVo2({ speedMs: 1.2, gradePct: -10, bodyKg: 70 });
    expect(down).toBeLessThan(flat);
    expect(down).toBeGreaterThan(flat * 0.6);
  });

  it("never returns a sub-resting value — the exact failure Pandolf has", () => {
    for (const g of [-5, -10, -20, -40]) {
      expect(walkingVo2({ speedMs: 1.2, gradePct: g, bodyKg: 70 })).toBeGreaterThan(3.05);
    }
  });

  it("is flat across steepness, which is the model's published limit", () => {
    // documented, not desirable: the descent branch carries no grade term at all
    const a = walkingVo2({ speedMs: 1.2, gradePct: -5, bodyKg: 70 });
    const b = walkingVo2({ speedMs: 1.2, gradePct: -25, bodyKg: 70 });
    expect(a).toBe(b);
  });
});

describe("toblerSpeedMs", () => {
  it("is 5 km/h on the flat", () => {
    expect(toblerSpeedMs(0) * 3.6).toBeCloseTo(5, 1);
  });

  it("peaks at 6 km/h on a gentle descent, not on the flat", () => {
    const peak = toblerSpeedMs(-0.05) * 3.6;
    expect(peak).toBeCloseTo(6, 5);
    expect(peak).toBeGreaterThan(toblerSpeedMs(0) * 3.6);
  });

  it("never exceeds walking pace — the thing Naismith-Langmuir gets wrong", () => {
    // Naismith with Langmuir implies ~12 km/h at −12°, faster than a human can walk
    for (let slope = -0.6; slope <= 0.6; slope += 0.01) {
      expect(toblerSpeedMs(slope) * 3.6).toBeLessThanOrEqual(6.001);
    }
  });

  it("slows on a climb, and more on a steeper one", () => {
    expect(toblerSpeedMs(0.1)).toBeLessThan(toblerSpeedMs(0));
    expect(toblerSpeedMs(0.3)).toBeLessThan(toblerSpeedMs(0.1));
  });

  it("applies the pack penalty at 1% per kg", () => {
    expect(toblerSpeedMs(0, 0) / toblerSpeedMs(0, 20)).toBeCloseTo(1.2, 5);
  });
});

describe("dayLegs — a climb is not a grade", () => {
  it("splits a day into a signed up leg and down leg", () => {
    const legs = dayLegs(16_000, 800);
    expect(legs).toHaveLength(2);
    expect(legs[0]!.slope).toBeGreaterThan(0);
    expect(legs[1]!.slope).toBeLessThan(0);
    // equal climb and drop → equal ground
    expect(legs[0]!.distanceM).toBeCloseTo(8000, 5);
    expect(legs[0]!.slope).toBeCloseTo(0.1, 5);
    expect(legs[1]!.slope).toBeCloseTo(-0.1, 5);
  });

  it("keeps the total distance exact", () => {
    for (const [d, a] of [[16_000, 800], [9_400, 210], [21_000, 1_400]] as const) {
      const total = dayLegs(d, a).reduce((s, l) => s + l.distanceM, 0);
      expect(total).toBeCloseTo(d, 5);
    }
  });

  it("gives the climbing leg more ground when the day climbs more than it drops", () => {
    const legs = dayLegs(10_000, 900, 100);
    expect(legs[0]!.distanceM).toBeGreaterThan(legs[1]!.distanceM);
    expect(legs[0]!.distanceM).toBeCloseTo(9000, 5);
  });

  it("is one flat leg when the day neither climbs nor drops", () => {
    expect(dayLegs(12_000, 0)).toEqual([{ distanceM: 12_000, slope: 0 }]);
  });

  it("has nothing to say about a day with no distance", () => {
    expect(dayLegs(0, 500)).toEqual([]);
  });
});

describe("estimateDay", () => {
  it("estimates a real day at a believable time and cost", () => {
    const day = estimateDay({ distanceM: 14_200, ascentM: 840, bodyKg: 70, loadKg: 14 })!;
    expect(day).not.toBeNull();
    // 14 km with 840 m of climb, carrying 14 kg — a solid but ordinary day
    expect(day.hours).toBeGreaterThan(3.5);
    expect(day.hours).toBeLessThan(8);
    expect(day.walkingKcal).toBeGreaterThan(1200);
    expect(day.walkingKcal).toBeLessThan(4500);
    expect(day.totalKcal).toBeGreaterThan(day.walkingKcal);
  });

  it("a heavier pack costs more time and more energy", () => {
    const base = { distanceM: 14_200, ascentM: 840, bodyKg: 70 } as const;
    const light = estimateDay({ ...base, loadKg: 6 })!;
    const heavy = estimateDay({ ...base, loadKg: 20 })!;
    expect(heavy.hours).toBeGreaterThan(light.hours);
    expect(heavy.walkingKcal).toBeGreaterThan(light.walkingKcal);
  });

  it("a climb costs more than the same distance flat", () => {
    const flat = estimateDay({ distanceM: 14_000, ascentM: 0, bodyKg: 70, loadKg: 12 })!;
    const climb = estimateDay({ distanceM: 14_000, ascentM: 1000, bodyKg: 70, loadKg: 12 })!;
    expect(climb.hours).toBeGreaterThan(flat.hours);
    expect(climb.walkingKcal).toBeGreaterThan(flat.walkingKcal);
  });

  it("declines a day nobody described, rather than calling it zero", () => {
    expect(estimateDay({ distanceM: 0, ascentM: 0, bodyKg: 70 })).toBeNull();
    expect(estimateDay({ distanceM: 14_000, ascentM: 0, bodyKg: 0 })).toBeNull();
  });
});

describe("restingKcal", () => {
  it("is proportional to time and body weight", () => {
    expect(restingKcal(70, 12)).toBeCloseTo(70 * 1.4 * 12, 5);
    expect(restingKcal(90, 12)).toBeGreaterThan(restingKcal(70, 12));
  });

  it("can't be asked for more than a day, or for a negative one", () => {
    expect(restingKcal(70, 40)).toBe(restingKcal(70, 24));
    expect(restingKcal(70, -5)).toBe(0);
  });
});

describe("burnDownMg — the pack gets lighter because you eat it", () => {
  it("declines across the trip", () => {
    const w = burnDownMg(14_000_000, 4_000_000, 5);
    expect(w).toHaveLength(5);
    for (let i = 1; i < w.length; i++) expect(w[i]!).toBeLessThan(w[i - 1]!);
  });

  it("uses each day's midpoint, so day 1 isn't the full pack and the last isn't empty", () => {
    const [first, , , , last] = burnDownMg(14_000_000, 5_000_000, 5);
    expect(first).toBeLessThan(14_000_000); // eaten some of day 1
    expect(first).toBeGreaterThan(13_000_000);
    expect(last).toBeGreaterThan(14_000_000 - 5_000_000); // hasn't eaten it all yet
  });

  it("never eats more than is carried", () => {
    const w = burnDownMg(3_000_000, 9_000_000, 4);
    for (const mg of w) expect(mg).toBeGreaterThanOrEqual(0);
  });

  it("has nothing to say about zero days", () => {
    expect(burnDownMg(14_000_000, 4_000_000, 0)).toEqual([]);
  });
});
