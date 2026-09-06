import { DAY_MS, parseIsoDate } from "~~/shared/calendar";

// Human "time ago" — one source of truth for the editor's sync-status line and the
// "Your lists" registry, so the two phrase elapsed time identically. Reads like
// speech ("just now", "1 hour ago", "yesterday"), staying calendar-aware at the
// day boundary (a real "yesterday", not "26 hours ago"), then settling to a plain
// date once it's old enough that a relative phrase stops helping.
//
// Client-only callers (both are) pass Date.now() by default; pass a reactive `now`
// (the useNow composable in app/composables/dom.ts) to get a label that re-renders
// as time passes without recomputing the base timestamp. Nuxt auto-imports
// app/utils, so callers use `timeAgo(...)` bare.
export function timeAgo(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000)); // clamp future skew to "just now"
  if (s < 45) return "just now";

  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "1 minute ago" : `${m} minutes ago`;

  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;

  // past a day, count whole CALENDAR days so the wording matches the reader's
  // sense of the date ("yesterday" the moment the clock rolls over, not at +24h)
  const then = new Date(ts);
  const today = new Date(now);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(then)) / DAY_MS);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;

  // old enough that a relative phrase no longer helps → a plain date; add the year
  // only when it isn't the current one, so most dates stay short
  const sameYear = then.getFullYear() === today.getFullYear();
  return then.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
}

// The `YYYY-MM-DD` → local Date step is shared/calendar.ts's — a trip starting "Aug 4"
// must read as Aug 4 in Portland, and that file explains why `new Date(iso)` doesn't.
const parseCalendarDate = parseIsoDate;

/**
 * One calendar date as prose: "September 6, 2026" — the same fixed-locale formatter
 * the range below uses, for a caller holding an ISO string (the What's new page's
 * release dates). Falls back to the string itself when it doesn't parse, so a bad
 * date is visible rather than blank.
 */
export function formatCalendarDate(iso: string): string {
  const d = parseCalendarDate(iso);
  return d ? fmtFull(d) : iso;
}

/**
 * A trip's dates, as one phrase: "September 6–9", "August 4 – September 2",
 * "December 30, 2026 – January 2, 2027".
 *
 * Collapses whatever the two dates share — a range inside one month prints the
 * month once — because the point of the line is the span, and repeating "August"
 * twice makes the reader do the comparison themselves.
 *
 * The YEAR is dropped when every date shown falls in the current calendar year
 * (`now`, injectable for tests): almost every trip is this year's, and "2026" on a
 * September trip in September is a number the reader already knows. It comes back
 * the moment it carries information — a trip in another year, or one that crosses
 * New Year, which always prints both years. Judged when the line is rendered, so
 * the same trip reads "September 6–9" this year and "September 6–9, 2026" next
 * January, which is exactly when the year starts to matter. (Ryan, 2026-09-05.)
 * Screen headers only: the exports keep the year, since a document read later has
 * to stand on its own.
 *
 * An open end is legitimate and prints as just the start: you often know when you
 * leave before you know when you're back.
 */
export function formatDateRange(start?: string, end?: string, now: Date = new Date()): string {
  const a = parseCalendarDate(start);
  const b = parseCalendarDate(end);
  if (!a && !b) return "";
  const thisYear = now.getFullYear();
  const one = (d: Date) => (d.getFullYear() === thisYear ? fmtMonthDay(d) : fmtFull(d));
  if (!a || !b) return one(a ?? b!);
  if (a.getTime() === b.getTime()) return one(a);

  const sameYear = a.getFullYear() === b.getFullYear();
  if (!sameYear) return `${fmtFull(a)} – ${fmtFull(b)}`;
  const year = b.getFullYear() === thisYear ? "" : `, ${b.getFullYear()}`;
  const sameMonth = a.getMonth() === b.getMonth();
  if (sameMonth) return `${fmtMonthDay(a)}–${b.getDate()}${year}`;
  return `${fmtMonthDay(a)} – ${fmtMonthDay(b)}${year}`;
}

const fmtFull = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const fmtMonthDay = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
