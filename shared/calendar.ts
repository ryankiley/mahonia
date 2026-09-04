// Calendar dates — `YYYY-MM-DD`, no time, no timezone — and the two honest ways to do
// arithmetic on one.
//
// A trip's dates are stored as TEXT (see ListMeta.startDate), because "August 4" is a
// day, not an instant: it has no offset, and it has to read as August 4 in Portland and
// in Tokyo alike. JavaScript has no calendar-date type, so every use has to pick a Date
// to stand in for it, and the choice is where the bugs were. `new Date("2026-08-04")`
// parses a bare ISO date as UTC MIDNIGHT — which toLocaleDateString then renders as the
// DAY BEFORE anywhere west of UTC. Five files had each worked this out and each kept
// its own copy of the answer; this is the one copy.
//
//  • For DISPLAY — a weekday, "September 6, 2026", a month grid — build a LOCAL Date
//    from the parts (parseIsoDate) and read local parts back (isoDate). The Date is a
//    vehicle for the calendar, never an instant.
//  • For ARITHMETIC — how many days a range covers, the day after an end date — anchor
//    every date at `T00:00:00Z` (utcMidnight) and work in whole days from there. UTC
//    has no DST, so two dates anchored that way are always an exact multiple of a day
//    apart; local midnights are not, and a range across a DST change would lose or
//    gain a day. Weekday names taken on the UTC side (shared/tripDay.ts) are read back
//    with `timeZone: "UTC"` for the same reason.
//
// Mixing the two is the failure mode: a UTC instant formatted in local time is the
// original bug again.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** One calendar day, in milliseconds — the unit the UTC side counts in. */
export const DAY_MS = 86_400_000;

/**
 * A `YYYY-MM-DD` string → a LOCAL Date on that calendar day, for display. Null for
 * anything that isn't one (including undefined, so an unset date needs no guard).
 */
export function parseIsoDate(iso: string | undefined): Date | null {
  const m = iso ? ISO_DATE.exec(iso) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** A local Date's calendar day as `YYYY-MM-DD` — the inverse of parseIsoDate. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The instant a calendar day begins in UTC, for arithmetic — NaN when the string isn't
 * a date, so a caller can refuse rather than compute on garbage.
 */
export function utcMidnight(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/**
 * A calendar day some whole number of days later (or earlier, negative), staying on
 * the calendar: "2026-08-31" + 1 is "2026-09-01". Counted on the UTC side so a DST
 * change can't turn one day into 23 or 25 hours. An unparseable date comes back as it
 * went in — there is no day after a non-date.
 */
export function shiftIsoDate(iso: string, days: number): string {
  const ms = utcMidnight(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}
