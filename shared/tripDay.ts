// What a day of a trip is CALLED.
//
// Extracted from the planning panel the moment a second view needed it: a shared list
// shows the itinerary too, and a day named "Tuesday, Day 2" in the editor that reads
// "Day 2" to whoever you sent the link to is the kind of drift nobody notices until it
// is everywhere.

/**
 * "Monday, Day 2" once the trip has dates, "Day 2" before that.
 *
 * The weekday is the thing people actually plan against ("the big climb is Tuesday"),
 * and the app already knows it: the day count comes from the dates, so day `i` IS
 * start + i.
 *
 * Parsed at `T00:00:00Z` and read back in UTC, matching how the dates are stored. A
 * local-midnight Date would name the wrong weekday for anyone west of UTC — the same
 * reason the dates are TEXT columns rather than timestamps.
 */
export function dayLabel(index: number, startDate: string | undefined): string {
  const n = `Day ${index + 1}`;
  if (!startDate) return n;
  const ms = Date.parse(`${startDate}T00:00:00Z`);
  if (Number.isNaN(ms)) return n;
  const weekday = new Date(ms + index * 86_400_000).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
  return `${weekday}, ${n}`;
}
