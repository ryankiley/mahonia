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
/** An ISO timestamp as epoch ms, or null for none or an unparseable one — the shape
 *  the sync line and the share views' meta line both hand timeAgo. */
export function parseIsoTime(iso: string | null | undefined): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

//
// `short` is for a column of them (the sharing menu's recent changes): "49m ago",
// "3h ago", "2d ago". "just now", "yesterday" and the dates are short already.
export function timeAgo(ts: number, now: number = Date.now(), opts: { short?: boolean } = {}): string {
  const s = Math.max(0, Math.round((now - ts) / 1000)); // clamp future skew to "just now"
  if (s < 45) return "just now";

  const m = Math.round(s / 60);
  if (m < 60) return opts.short ? `${m}m ago` : m === 1 ? "1 minute ago" : `${m} minutes ago`;

  const h = Math.round(m / 60);
  if (h < 24) return opts.short ? `${h}h ago` : h === 1 ? "1 hour ago" : `${h} hours ago`;

  // past a day, count whole CALENDAR days so the wording matches the reader's
  // sense of the date ("yesterday" the moment the clock rolls over, not at +24h)
  const then = new Date(ts);
  const today = new Date(now);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(then)) / DAY_MS);
  if (days <= 1) return "yesterday";
  if (days < 7) return opts.short ? `${days}d ago` : `${days} days ago`;

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
 *
 * `relative` words a trip that starts in the coming week the way people say it:
 * "Tomorrow", "Friday", "Friday – Sunday", "Tomorrow – November 20". The same rule as
 * the year, one step further: within a week you plan in weekdays (the forecast, the day
 * off), so the weekday is what you think in and "November 13" is the number you'd have
 * to convert. Six days is the edge because a week out "Friday" stops saying which one.
 * A trip already underway or over keeps its dates. Words only, no "on": the label is a
 * value beside a calendar mark, not a sentence. (Ryan, 2026-11-10.)
 *
 * Opt-in because it is only right on the READER's clock: a server render knows neither
 * their timezone nor when they'll look, so an SSR caller turns it on after hydration,
 * and a label that stays on screen re-renders from a ticking `now` so "Tomorrow" doesn't
 * survive the night.
 */
export function formatDateRange(
  start?: string,
  end?: string,
  now: Date = new Date(),
  opts: { relative?: boolean } = {},
): string {
  // The `YYYY-MM-DD` → local Date step is shared/calendar.ts's — a trip starting "Aug 4"
  // must read as Aug 4 in Portland, and that file explains why `new Date(iso)` doesn't.
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  if (!a && !b) return "";
  const thisYear = now.getFullYear();
  const one = (d: Date) => (d.getFullYear() === thisYear ? fmtMonthDay(d) : fmtFull(d));
  const soon = (d: Date) => (opts.relative ? inTheComingWeek(d, now) : null);
  const label = (d: Date) => soon(d) ?? one(d);
  if (!a || !b) return label(a ?? b!);
  if (a.getTime() === b.getTime()) return label(a);
  const first = soon(a);
  if (first) return `${first} – ${label(b)}`;

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

/** "Today", "Tomorrow" or the weekday for a calendar day 0–6 days after `now`'s; null
 *  for any other. Rounded, so a DST day's 23 or 25 hours still count as one. */
function inTheComingWeek(d: Date, now: Date): string | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((d.getTime() - today.getTime()) / DAY_MS);
  if (days < 0 || days > 6) return null;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "long" });
}
