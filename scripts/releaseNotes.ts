// A GitHub Release per changelog date: the tag, the title and the body, derived from
// the same entries the site renders. Pure, so tests/releaseNotes.test.ts covers it
// without git or gh; scripts/release-notes.ts is the CLI the workflow calls, and
// .github/workflows/releases.yml does the tagging.
//
// The version scheme is the date. Every push to main deploys and the changelog has
// always been keyed by the day a change shipped, so a release is a day and its tag is
// that day in CalVer: v2026.09.12. SemVer would be a number nothing consumes. The one
// real version number here is the MCP server's (server/utils/mcp.ts), which clients
// and the registry read; it moves on its own schedule and has nothing to do with these.
//
// A day is released once it is over (in the changelog's own timezone, Pacific), so its
// entries are settled. A fragment dated D that merges on D+2 still lands in release D:
// the workflow rewrites a release's notes whenever they differ from the entries, so
// the body is never stale, only the tag stands still. The Releases page IS the
// changelog: the site no longer renders one, and /changelog redirects here.

import type { ChangelogRelease } from "../shared/changelog";

/** The timezone the changelog's dates are written in — `npm run changelog` stamps today on this clock too. */
export const CHANGELOG_TZ = "America/Los_Angeles";

/** `2026-09-12` → `v2026.09.12`. CalVer, dotted, sorts the same way the dates do. */
export function tagFor(date: string): string {
  return `v${date.replaceAll("-", ".")}`;
}

/** Today's date in the changelog's timezone, as `YYYY-MM-DD`. */
export function todayIn(tz: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD; the parts API would too, at three times the length
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * The releases whose day is over: strictly before `today`. Oldest first, which is the
 * order to create them in, so the newest ends up marked "latest" on GitHub.
 */
export function settledReleases(releases: ChangelogRelease[], today: string): ChangelogRelease[] {
  return releases.filter((r) => r.date < today).sort((a, b) => a.date.localeCompare(b.date));
}

/** "September 12, 2026", the way the site prints it, plus the day's headline if it has one. */
export function releaseTitle(rel: ChangelogRelease): string {
  const [y, m, d] = rel.date.split("-").map(Number);
  // built in UTC and formatted in UTC so the day can't roll over on the machine's clock
  const pretty = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return rel.title ? `${pretty}: ${rel.title}` : pretty;
}

const GROUPS = [
  ["added", "Added"],
  ["changed", "Changed"],
  ["fixed", "Fixed"],
] as const;

/** The release body: the day's entries grouped Added / Changed / Fixed, Keep-a-Changelog style. */
export function releaseBody(rel: ChangelogRelease): string {
  const sections = GROUPS.filter(([key]) => rel[key]?.length).map(
    ([key, label]) => `### ${label}\n\n${rel[key]!.map((item) => `- ${item}`).join("\n")}`,
  );
  return `${sections.join("\n\n")}\n`;
}
