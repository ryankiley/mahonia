import { describe, expect, it } from "vitest";
import { DAYLIGHT_MARGIN_H, daylightHours, formatDaylight, lightIsShort, solarDeclinationDeg } from "../shared/daylight";

// The Sun is the one input this app models that has published answers to the minute,
// so the anchors here are sunrise-to-sunset figures from the standard tables (upper
// limb, refraction-corrected), not values the code produced and then pinned.

const PORTLAND = { lat: 45.52, lon: -122.68 };
const hm = (h: number, m: number) => h + m / 60;
/** within `minutes` of the published figure */
const within = (actual: number | null, expected: number, minutes: number) => {
  expect(actual).not.toBeNull();
  expect(Math.abs(actual! - expected) * 60).toBeLessThanOrEqual(minutes);
};

describe("daylightHours", () => {
  it("Portland on the June solstice: 15 h 41 min", () => {
    within(daylightHours(PORTLAND, "2026-06-21"), hm(15, 41), 2);
  });

  it("Portland on the December solstice: 8 h 42 min", () => {
    within(daylightHours(PORTLAND, "2026-12-21"), hm(8, 42), 2);
  });

  it("the equinox is a little over twelve hours, because the tables count the upper limb", () => {
    // refraction + the Sun's semidiameter lift the horizon 0.833°, worth ~7 min at the
    // equator and ~9 at 45°; a model that used the Sun's centre would say exactly 12
    within(daylightHours({ lat: 0, lon: 0 }, "2026-03-20"), hm(12, 7), 2);
    within(daylightHours({ lat: 45, lon: 0 }, "2026-03-20"), hm(12, 9), 3);
  });

  it("the equator keeps its twelve-and-a-bit all year", () => {
    for (const iso of ["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]) {
      within(daylightHours({ lat: 0, lon: 0 }, iso), hm(12, 7), 2);
    }
  });

  it("polar night is 0 and a midnight sun is 24, not NaN", () => {
    expect(daylightHours({ lat: 80, lon: 0 }, "2026-12-21")).toBe(0);
    expect(daylightHours({ lat: 80, lon: 0 }, "2026-06-21")).toBe(24);
    expect(daylightHours({ lat: -80, lon: 0 }, "2026-06-21")).toBe(0);
    expect(daylightHours({ lat: -80, lon: 0 }, "2026-12-21")).toBe(24);
  });

  it("the southern hemisphere mirrors the northern one, six months apart", () => {
    const south = daylightHours({ lat: -45.52, lon: -122.68 }, "2026-06-21")!;
    const north = daylightHours(PORTLAND, "2026-12-21")!;
    expect(Math.abs(south - north) * 60).toBeLessThan(3);
  });

  it("longitude barely moves it: the same day is the same length around a parallel", () => {
    const west = daylightHours(PORTLAND, "2026-06-21")!;
    const east = daylightHours({ lat: 45.52, lon: 150 }, "2026-06-21")!;
    expect(Math.abs(west - east) * 60).toBeLessThan(1.5);
  });

  it("grows day on day from midwinter to midsummer", () => {
    let last = daylightHours(PORTLAND, "2025-12-21")!;
    for (const iso of ["2026-01-21", "2026-02-21", "2026-03-21", "2026-04-21", "2026-05-21", "2026-06-21"]) {
      const next = daylightHours(PORTLAND, iso)!;
      expect(next).toBeGreaterThan(last);
      last = next;
    }
  });

  it("declines rather than computes on a string that isn't a date", () => {
    expect(daylightHours(PORTLAND, "")).toBeNull();
    expect(daylightHours(PORTLAND, "June 21")).toBeNull();
    expect(daylightHours(PORTLAND, "2026-13-40")).toBeNull();
  });
});

describe("solarDeclinationDeg", () => {
  // Julian day of a date's noon in Greenwich
  const jdNoon = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 86_400_000 + 2440587.5;

  it("reaches the tropics at the solstices and the equator at the equinox", () => {
    expect(solarDeclinationDeg(jdNoon("2026-06-21"))).toBeCloseTo(23.44, 1);
    expect(solarDeclinationDeg(jdNoon("2026-12-21"))).toBeCloseTo(-23.44, 1);
    expect(Math.abs(solarDeclinationDeg(jdNoon("2026-03-20")))).toBeLessThan(0.3);
  });
});

describe("lightIsShort", () => {
  it("flags a walk that runs past the light less the margin, and nothing else", () => {
    expect(lightIsShort(9, 12)).toBe(false); // three hours to spare
    expect(lightIsShort(10.5, 12)).toBe(true); // an hour and a half
    expect(lightIsShort(13, 12)).toBe(true); // after dark, plainly
    expect(lightIsShort(12 - DAYLIGHT_MARGIN_H, 12)).toBe(false); // exactly the margin is not short
  });

  it("says nothing without both figures", () => {
    expect(lightIsShort(undefined, 12)).toBe(false);
    expect(lightIsShort(9, null)).toBe(false);
    expect(lightIsShort(9, undefined)).toBe(false);
  });
});

describe("formatDaylight", () => {
  it("reads to the minute, dropping a zero minute", () => {
    expect(formatDaylight(15.686)).toBe("15 h 41 min");
    expect(formatDaylight(12)).toBe("12 h");
    expect(formatDaylight(0)).toBe("0 h");
    expect(formatDaylight(8.9999)).toBe("9 h"); // rounds to the minute, then carries
  });
});
