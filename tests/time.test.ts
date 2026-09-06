import { describe, expect, it } from "vitest";
import { formatDateRange, timeAgo } from "../app/utils/time";

// timeAgo is the one relative-time formatter shared by the editor's sync-status
// line and the "Your lists" registry, so the two phrase elapsed time identically.
// Times are built with the LOCAL Date constructor (not Date.UTC) so the calendar-
// day math lands the same way in the formatter and the assertions, whatever TZ the
// runner uses. `now` is a fixed local noon so nothing depends on the wall clock.
describe("timeAgo", () => {
  const now = new Date(2026, 6, 12, 12, 0, 0).getTime(); // Sun 2026-07-12, local noon
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const at = (ms: number) => timeAgo(now - ms, now);
  const on = (y: number, mo: number, d: number, h = 12) =>
    timeAgo(new Date(y, mo, d, h).getTime(), now);

  it("says 'just now' under ~a minute", () => {
    expect(at(0)).toBe("just now");
    expect(at(30 * S)).toBe("just now");
    expect(at(44 * S)).toBe("just now");
  });

  it("counts minutes in words, singular vs plural", () => {
    expect(at(1 * M)).toBe("1 minute ago");
    expect(at(5 * M)).toBe("5 minutes ago");
    expect(at(59 * M)).toBe("59 minutes ago");
  });

  it("counts hours in words within the day", () => {
    expect(at(1 * H)).toBe("1 hour ago");
    expect(at(3 * H)).toBe("3 hours ago");
    expect(at(11 * H)).toBe("11 hours ago"); // still Sun (noon − 11h = 1am)
  });

  it("uses a real 'yesterday' at the calendar boundary", () => {
    expect(on(2026, 6, 11)).toBe("yesterday"); // Sat noon → 24h, but says yesterday
    expect(on(2026, 6, 11, 6)).toBe("yesterday"); // Sat 6am
  });

  it("counts a few calendar days, then falls back to a date", () => {
    expect(on(2026, 6, 10)).toBe("2 days ago"); // Fri
    expect(on(2026, 6, 6)).toBe("6 days ago"); // Mon
    // a week+ out → a plain "Mon D" date, never "Nd ago"
    const wk = on(2026, 5, 20); // Jun 20
    expect(wk).not.toMatch(/ago|yesterday/);
    expect(wk).toMatch(/Jun|6/);
  });

  it("includes the year only when it isn't the current one", () => {
    const label = on(2025, 6, 1); // Jul 1, 2025
    expect(label).toMatch(/2025/);
  });

  it("clamps a future timestamp (clock skew) to 'just now'", () => {
    expect(timeAgo(now + 5 * M, now)).toBe("just now");
  });
});

// A trip's dates, as the meta row and the shared read pages print them.
//
// Month-first, and the collapse puts the two DAYS together with the month and year
// said once — so the shape of the line changes with what the ends share, not just the
// words. That is the part worth pinning: a plain locale swap would have produced
// "6–September 9, 2026" for a range inside one month.
//
// The locale is fixed on purpose (see the note beside the formatters): these render in
// the editor AND in server-rendered HTML, so reading the visitor's locale would format
// one way in the cached page and another after hydration.
describe("formatDateRange", () => {
  // the year is judged against `now`: these run as if it were 2020, so 2026 prints
  const then = new Date(2020, 0, 15);
  it("collapses a range inside one month to one month and one year", () => {
    expect(formatDateRange("2026-09-06", "2026-09-09", then)).toBe("September 6–9, 2026");
  });
  it("prints both months across a month boundary, the year once", () => {
    expect(formatDateRange("2026-09-28", "2026-10-03", then)).toBe("September 28 – October 3, 2026");
  });
  it("prints both dates in full across a year boundary", () => {
    expect(formatDateRange("2026-12-30", "2027-01-02", then)).toBe("December 30, 2026 – January 2, 2027");
  });
  it("prints one date when the two are the same day", () => {
    expect(formatDateRange("2026-09-06", "2026-09-06", then)).toBe("September 6, 2026");
  });
  it("prints just the start for an open end", () => {
    expect(formatDateRange("2026-09-06", undefined, then)).toBe("September 6, 2026");
    expect(formatDateRange("2026-09-06", "", then)).toBe("September 6, 2026");
  });
  it("prints just the end when only the end is set", () => {
    expect(formatDateRange(undefined, "2026-09-09", then)).toBe("September 9, 2026");
  });
  it("is empty with nothing to show", () => {
    expect(formatDateRange()).toBe("");
    expect(formatDateRange("", "")).toBe("");
    expect(formatDateRange("not-a-date", "also-not")).toBe("");
  });

  describe("in the trip's own year, the year goes unsaid", () => {
    const now = new Date(2026, 8, 5);
    it("inside one month", () => {
      expect(formatDateRange("2026-09-06", "2026-09-09", now)).toBe("September 6–9");
    });
    it("across a month boundary", () => {
      expect(formatDateRange("2026-09-28", "2026-10-03", now)).toBe("September 28 – October 3");
    });
    it("on a single day and an open end", () => {
      expect(formatDateRange("2026-09-06", "2026-09-06", now)).toBe("September 6");
      expect(formatDateRange("2026-09-06", undefined, now)).toBe("September 6");
      expect(formatDateRange(undefined, "2026-09-09", now)).toBe("September 9");
    });
    it("but a trip that crosses New Year always names both years", () => {
      expect(formatDateRange("2026-12-30", "2027-01-02", now)).toBe("December 30, 2026 – January 2, 2027");
    });
    it("and any other year is named, past or future", () => {
      expect(formatDateRange("2025-09-06", "2025-09-09", now)).toBe("September 6–9, 2025");
      expect(formatDateRange("2027-06-01", "2027-06-04", now)).toBe("June 1–4, 2027");
      expect(formatDateRange("2025-09-06", undefined, now)).toBe("September 6, 2025");
    });
    it("defaults `now` to today, so a trip this year drops the year on screen", () => {
      const y = new Date().getFullYear();
      expect(formatDateRange(`${y}-09-06`, `${y}-09-09`)).toBe("September 6–9");
    });
  });
});
