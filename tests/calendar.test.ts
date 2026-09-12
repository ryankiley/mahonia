import { describe, expect, it } from "vitest";
import { DAY_MS, isCalendarDate, isoDate, parseIsoDate, shiftIsoDate, utcMidnight } from "../shared/calendar";

// The one place the app turns a `YYYY-MM-DD` into a Date. The two halves answer
// different questions — a LOCAL Date for display, a UTC instant for arithmetic — and
// the tests below run each in several timezones, because the whole reason the module
// exists is that the naive `new Date(iso)` is right in London and a day early in
// Portland.

/** Run `fn` with TZ pinned, restoring it after. */
function inZones(fn: () => void) {
  const tz = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      fn();
    }
  } finally {
    process.env.TZ = tz;
  }
}

describe("parseIsoDate — a local Date for display", () => {
  it("lands on the named day whatever the timezone", () => {
    inZones(() => {
      const d = parseIsoDate("2026-08-04")!;
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(7);
      expect(d.getDate()).toBe(4);
    });
  });

  it("refuses anything that isn't a calendar date", () => {
    expect(parseIsoDate(undefined)).toBeNull();
    expect(parseIsoDate("")).toBeNull();
    expect(parseIsoDate("not-a-date")).toBeNull();
    expect(parseIsoDate("2026-8-4")).toBeNull();
    expect(parseIsoDate("2026-08-04T00:00:00Z")).toBeNull();
    // A format-shaped non-date used to roll forward through Date construction
    // (2026-02-31 → March 3), so a corrupted stored date silently became a
    // different valid day in every display and trip calculation.
    expect(parseIsoDate("2026-02-31")).toBeNull();
    expect(parseIsoDate("2025-02-29")).toBeNull();
  });
});

describe("isCalendarDate — a strict boundary check for untyped input", () => {
  it("accepts real canonical days and refuses rollover or non-string input", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2025-02-29")).toBe(false);
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("2026-8-04")).toBe(false);
    expect(isCalendarDate({ date: "2026-08-04" })).toBe(false);
  });
});

describe("isoDate — the inverse, from local parts", () => {
  it("round-trips through parseIsoDate", () => {
    inZones(() => {
      for (const iso of ["2026-01-01", "2026-08-04", "2026-12-31"]) {
        expect(isoDate(parseIsoDate(iso)!)).toBe(iso);
      }
    });
  });

  it("zero-pads month and day", () => {
    expect(isoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("utcMidnight — the instant a day starts, for arithmetic", () => {
  it("is timezone-independent", () => {
    inZones(() => {
      expect(utcMidnight("2026-08-04")).toBe(Date.UTC(2026, 7, 4));
    });
  });

  it("is NaN for a non-date, so a caller can refuse", () => {
    expect(utcMidnight("nope")).toBeNaN();
    expect(utcMidnight("2026-02-31")).toBeNaN();
  });

  it("puts consecutive days exactly one DAY_MS apart", () => {
    expect(utcMidnight("2026-08-05") - utcMidnight("2026-08-04")).toBe(DAY_MS);
  });
});

describe("shiftIsoDate — a day later, staying on the calendar", () => {
  it("steps forward and back", () => {
    expect(shiftIsoDate("2026-08-04", 1)).toBe("2026-08-05");
    expect(shiftIsoDate("2026-08-04", -1)).toBe("2026-08-03");
  });

  it("crosses a month and a year boundary", () => {
    expect(shiftIsoDate("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftIsoDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftIsoDate("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("is not thrown off by a DST change or the runner's timezone", () => {
    inZones(() => {
      // the US spring-forward Sunday in 2026 is March 8; a local-midnight count would
      // come up an hour short and round to the wrong day
      expect(shiftIsoDate("2026-03-07", 1)).toBe("2026-03-08");
      expect(shiftIsoDate("2026-03-08", 1)).toBe("2026-03-09");
    });
  });

  it("hands back a non-date untouched", () => {
    expect(shiftIsoDate("nope", 1)).toBe("nope");
    expect(shiftIsoDate("2026-02-31", 1)).toBe("2026-02-31");
  });

  it("refuses a non-whole shift instead of producing a partial calendar day", () => {
    expect(shiftIsoDate("2026-08-04", 1.5)).toBe("2026-08-04");
    expect(shiftIsoDate("2026-08-04", Number.NaN)).toBe("2026-08-04");
  });
});
