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
  it("collapses a range inside one month to two days, month and year once", () => {
    expect(formatDateRange("2026-09-06", "2026-09-09")).toBe("September 6–9, 2026");
  });

  it("names both months when the range crosses one, year once", () => {
    expect(formatDateRange("2026-09-28", "2026-10-03")).toBe("September 28 – October 3, 2026");
  });

  it("prints both years when the range crosses one", () => {
    expect(formatDateRange("2026-12-30", "2027-01-02")).toBe("December 30, 2026 – January 2, 2027");
  });

  it("prints a single date when both ends are the same day", () => {
    expect(formatDateRange("2026-09-06", "2026-09-06")).toBe("September 6, 2026");
  });

  it("prints just the start when the end is open", () => {
    // you often know when you leave before you know when you're back
    expect(formatDateRange("2026-09-06")).toBe("September 6, 2026");
    expect(formatDateRange("2026-09-06", "")).toBe("September 6, 2026");
  });

  it("prints the end alone when only an end is set", () => {
    expect(formatDateRange(undefined, "2026-09-09")).toBe("September 9, 2026");
  });

  it("is empty when there are no dates, and ignores unparseable ones", () => {
    expect(formatDateRange()).toBe("");
    expect(formatDateRange("", "")).toBe("");
    expect(formatDateRange("not-a-date", "also-not")).toBe("");
  });

  it("does not shift a date across a timezone boundary", () => {
    // calendar dates, not instants — parsed from parts, so the 1st stays the 1st even
    // when the runner sits west of UTC and `new Date(iso)` would land a day early
    expect(formatDateRange("2026-09-01", "2026-09-01")).toBe("September 1, 2026");
  });
});
