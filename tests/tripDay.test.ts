import { describe, expect, it } from "vitest";
import { dayLabel } from "../shared/tripDay";
import { normalizeCalendarDate } from "../shared/ops";

// Naming a day was extracted out of the planning panel when a second view needed it: a
// shared list shows the itinerary, and a day called "Tuesday, Day 2" in the editor that
// reads "Day 2" to whoever you sent the link to is drift nobody notices until it's
// everywhere. One implementation, so there is one answer.

describe("what a day of a trip is called", () => {
  it("is just its number before the trip has dates", () => {
    expect(dayLabel(0, undefined)).toBe("Day 1");
    expect(dayLabel(3, undefined)).toBe("Day 4");
  });

  it("takes the weekday from the start date once there is one", () => {
    // 2026-08-10 is a Monday
    expect(dayLabel(0, "2026-08-10")).toBe("Monday, Day 1");
    expect(dayLabel(1, "2026-08-10")).toBe("Tuesday, Day 2");
    expect(dayLabel(6, "2026-08-10")).toBe("Sunday, Day 7");
  });

  it("rolls past the end of a week", () => {
    expect(dayLabel(7, "2026-08-10")).toBe("Monday, Day 8");
  });

  it("names the same weekday regardless of the reader's timezone", () => {
    // The whole reason the date is parsed at T00:00:00Z and read back in UTC. A
    // local-midnight Date would step back a day for anyone west of UTC, so a trip
    // starting Monday would greet a reader in Los Angeles with "Sunday, Day 1".
    const tz = process.env.TZ;
    try {
      for (const zone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tokyo"]) {
        process.env.TZ = zone;
        expect(dayLabel(0, "2026-08-10")).toBe("Monday, Day 1");
      }
    } finally {
      process.env.TZ = tz;
    }
  });

  it("falls back to the bare number rather than inventing a weekday", () => {
    // a hand-edited backup can carry anything in that column
    expect(dayLabel(0, "not-a-date")).toBe("Day 1");
    expect(dayLabel(2, "")).toBe("Day 3");
  });

  it("never sees a date that exists only by rollover, because the reducer rejects it", () => {
    // Date.parse("2026-02-31T00:00:00Z") does NOT fail — V8 rolls it into March, so this
    // function alone would happily name a weekday for a day that doesn't exist. It never
    // gets the chance: normalizeCalendarDate round-trips the value back through
    // toISOString and drops anything that didn't survive, on every write path. Pinned
    // here so that guard can't be relaxed without this failing.
    expect(normalizeCalendarDate("2026-02-31")).toBeUndefined();
    expect(normalizeCalendarDate("2026-08-10")).toBe("2026-08-10");
  });
});
