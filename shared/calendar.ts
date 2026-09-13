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

type CalendarParts = { year: number; month: number; day: number; utcMs: number };

/**
 * Read a strict calendar date once for both the local-display and UTC-arithmetic
 * sides. The shape check alone is not enough: JavaScript silently turns
 * `2026-02-31` into March 3, which makes an invalid stored value look like a
 * different, legitimate trip day.
 */
function calendarParts(iso: string | undefined): CalendarParts | null {
  const m = iso ? ISO_DATE.exec(iso) : null;
  if (!m) return null;
  const utcMs = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(utcMs) || new Date(utcMs).toISOString().slice(0, 10) !== iso) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), utcMs };
}

/**
 * True only for a real, canonical `YYYY-MM-DD` calendar date. Accepts unknown
 * input so importers and command-line tools can validate untyped data before
 * passing it into the date helpers below.
 */
export function isCalendarDate(raw: unknown): raw is string {
  return typeof raw === "string" && calendarParts(raw) !== null;
}

/** A local Date without Date's special 1900 offset for years 0–99. */
function localDate({ year, month, day }: CalendarParts): Date {
  const d = new Date(0);
  d.setFullYear(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** One calendar day, in milliseconds — the unit the UTC side counts in. */
export const DAY_MS = 86_400_000;

/**
 * A `YYYY-MM-DD` string → a LOCAL Date on that calendar day, for display. Null for
 * anything that isn't one (including undefined, so an unset date needs no guard).
 */
export function parseIsoDate(iso: string | undefined): Date | null {
  const parts = calendarParts(iso);
  return parts ? localDate(parts) : null;
}

/** A local Date's calendar day as `YYYY-MM-DD` — the inverse of parseIsoDate. */
export function isoDate(d: Date): string {
  return `${String(d.getFullYear()).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The instant a calendar day begins in UTC, for arithmetic — NaN when the string isn't
 * a date, so a caller can refuse rather than compute on garbage.
 */
export function utcMidnight(iso: string): number {
  return calendarParts(iso)?.utcMs ?? Number.NaN;
}

/**
 * A calendar day some whole number of days later (or earlier, negative), staying on
 * the calendar: "2026-08-31" + 1 is "2026-09-01". Counted on the UTC side so a DST
 * change can't turn one day into 23 or 25 hours. An unparseable date comes back as it
 * went in — there is no day after a non-date.
 */
export function shiftIsoDate(iso: string, days: number): string {
  const ms = utcMidnight(iso);
  if (Number.isNaN(ms) || !Number.isSafeInteger(days)) return iso;
  const shifted = new Date(ms + days * DAY_MS);
  if (Number.isNaN(shifted.getTime())) return iso;
  const next = shifted.toISOString().slice(0, 10);
  return ISO_DATE.test(next) ? next : iso;
}
