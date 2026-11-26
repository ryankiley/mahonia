// The calendar a trip's dates wear says how many there are: a calendar with a plus while
// there are none, one marked day for a single date, a page of days for a range. It was
// the page of days for all three.
import { describe, expect, it } from "vitest";
import { IconCalendarAdd4, IconCalendarDays, IconCalendarToday } from "~/icons/central";
import { datesIcon } from "~/utils/datesIcon";

describe("the dates icon", () => {
  it("is a calendar with a plus while there are no dates to show", () => {
    expect(datesIcon("", "")).toBe(IconCalendarAdd4);
    expect(datesIcon(null, null)).toBe(IconCalendarAdd4);
    expect(datesIcon(undefined, undefined)).toBe(IconCalendarAdd4);
  });

  it("is one marked day for a single date, however that is stored", () => {
    expect(datesIcon("2026-12-04", "")).toBe(IconCalendarToday);
    expect(datesIcon("2026-12-04", null)).toBe(IconCalendarToday);
    expect(datesIcon("2026-12-04", "2026-12-04")).toBe(IconCalendarToday);
  });

  it("is a page of days for a range", () => {
    expect(datesIcon("2026-12-04", "2026-12-07")).toBe(IconCalendarDays);
  });
});
