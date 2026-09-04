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
  const days = Math.round((startOfDay(today) - startOfDay(then)) / 86_400_000);
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

/**
 * Parse a `YYYY-MM-DD` calendar date into a LOCAL Date.
 *
 * From the parts, never `new Date(iso)` — that parses bare ISO dates as UTC
 * midnight, which formats as the DAY BEFORE anywhere west of UTC. A trip starting
 * "Aug 4" must read as Aug 4 in Portland.
 */
function parseCalendarDate(iso: string | undefined): Date | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * A trip's dates, as one phrase: "September 6–9, 2026", "September 6, 2026",
 * "August 30 – September 2, 2026".
 *
 * Collapses whatever the two dates share — a range inside one month prints the
 * month and year once — because the point of the line is the span, and repeating
 * "Aug 2026" twice makes the reader do the comparison themselves.
 *
 * An open end is legitimate and prints as just the start: you often know when you
 * leave before you know when you're back.
 */
export function formatDateRange(start?: string, end?: string): string {
  const a = parseCalendarDate(start);
  const b = parseCalendarDate(end);
  if (!a && !b) return "";
  // one date, or only an end — either way there is a single date to print
  if (!a || !b) return fmtFull(a ?? b!);
  if (a.getTime() === b.getTime()) return fmtFull(a);

  const sameYear = a.getFullYear() === b.getFullYear();
  const sameMonth = sameYear && a.getMonth() === b.getMonth();
  // en dash, not a hyphen: this is a range, and the two read differently at size.
  // Month-first, so the collapse puts the two DAYS side by side and says the month
  // and year once: "September 6–9, 2026". Day-first order would have produced
  // "6–September 9, 2026", which is why this isn't just a locale swap.
  if (sameMonth) return `${fmtMonthDay(a)}–${b.getDate()}, ${b.getFullYear()}`;
  if (sameYear) return `${fmtMonthDay(a)} – ${fmtFull(b)}`;
  return `${fmtFull(a)} – ${fmtFull(b)}`;
}

/** One calendar date, in full — "July 17, 2026". Falls back to the raw string when it
 *  isn't a bare ISO date, so a malformed entry is still visible rather than blank. */
export function formatCalendarDate(iso: string): string {
  const d = parseCalendarDate(iso);
  return d ? fmtFull(d) : iso;
}

// Locale PINNED, matching the rule in shared/weights.ts: these render in the editor
// AND on the server-rendered share views, so reading the visitor's own locale would
// format one way in the cached HTML and another after hydration — a mismatch on every
// shared page. One fixed locale is the price of server rendering these at all.
const fmtFull = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const fmtMonthDay = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
