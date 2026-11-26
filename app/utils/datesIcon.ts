import { IconCalendar1, IconCalendarAdd4 } from "~/icons/central";
import type { IconNode } from "~/utils/icon";

/**
 * The calendar a trip's dates wear: one with a plus while there are none to show, and
 * the plain calendar once there are. Both are the same ringed outline, so setting a date
 * changes what is inside it and not its shape. It was a ringless page with one dot for a
 * single date and a grid of dots for a range, which the words beside it already say.
 */
export function datesIcon(start: string | null | undefined): IconNode {
  return start ? IconCalendar1 : IconCalendarAdd4;
}
