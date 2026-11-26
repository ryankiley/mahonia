// The calendar a trip's dates wear: a calendar with a plus while there are none, and the
// plain ringed calendar once there are, one date or a range.
import { describe, expect, it } from "vitest";
import { IconCalendar1, IconCalendarAdd4 } from "~/icons/central";
import { datesIcon } from "~/utils/datesIcon";

describe("the dates icon", () => {
  it("is a calendar with a plus while there is no date to show", () => {
    expect(datesIcon("")).toBe(IconCalendarAdd4);
    expect(datesIcon(null)).toBe(IconCalendarAdd4);
    expect(datesIcon(undefined)).toBe(IconCalendarAdd4);
  });

  it("is the ringed calendar once there is one", () => {
    expect(datesIcon("2026-12-04")).toBe(IconCalendar1);
  });
});
