import { describe, expect, it } from "vitest";
import { timeAgo } from "../app/utils/time";

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
