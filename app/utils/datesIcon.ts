import { IconCalendarAdd4, IconCalendarDays, IconCalendarToday } from "~/icons/central";
import type { IconNode } from "~/utils/icon";

/**
 * The calendar a trip's dates wear, which says how many there are before the words do:
 * a calendar with a plus while there are none to show, one marked day for a single
 * date, and a page of days for a range. It was the page of days for all three, so "Add
 * dates" and a day trip looked the same as a week away.
 */
export function datesIcon(start: string | null | undefined, end: string | null | undefined): IconNode {
  if (!start) return IconCalendarAdd4;
  return !end || end === start ? IconCalendarToday : IconCalendarDays;
}
