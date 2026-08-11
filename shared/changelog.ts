// The "What's new" changelog — the framework-agnostic type, ordering and merge
// for the site's product changelog. Pure, so it unit-tests without Nuxt or a
// database.
//
// Entries live in TWO places, and mergeReleases below is what makes them one:
//
//   content/changelog.d/*.json  one file per PR, only ever ADDED
//   content/changelog.json      the archive, touched only by changelog:compact
//
// That split exists for one reason: a single shared file could not survive the
// merge rate. Every PR shipped on a given day appended bullets to the SAME
// release object at the top of changelog.json, so two PRs open at once conflicted
// on the same handful of lines — 28 commits touched that file on one day. Two PRs
// cannot conflict on files neither of them shares, so an entry became a new file.
// scripts/build-changelog.ts folds both into content/changelog.generated.json at
// build time, which is what the /about endpoint reads.
//
// Entries are hand-written per PR — never auto-generated. A changelog-reminder
// comment nudges a user-facing PR that's missing one, but nothing scrapes the PR
// title; if an entry is forgotten the page just omits that change until backfilled.
//
// Entry style is the house rule: plain, one or two user-facing sentences (the
// observable change, not the implementation), grouped Keep-a-Changelog style.
//
// Dates are plain checked-in content, never derived from git at build time —
// Vercel builds from a shallow clone where per-file git history is wrong.

export interface ChangelogRelease {
  /** ISO date (YYYY-MM-DD) the change shipped. */
  date: string;
  /** Optional short headline for the batch (e.g. "Mahonia is live"). */
  title?: string;
  /** Plain, user-facing entries, grouped Added / Changed / Fixed. */
  added?: string[];
  changed?: string[];
  fixed?: string[];
}

// Newest first. localeCompare on ISO dates sorts chronologically; Array.sort is
// stable, so same-day batches keep their authored order. Sorts a copy — never
// mutates the input.
export function sortReleases(releases: ChangelogRelease[]): ChangelogRelease[] {
  return [...releases].sort((a, b) => b.date.localeCompare(a.date));
}

// Fold many releases into one per date, newest first.
//
// The input is the archive followed by every fragment, and a day is usually
// several fragments — five PRs shipped on Tuesday are five files that have to
// read as one Tuesday on the page. Bullets concatenate in the order given, which
// the caller fixes by sorting fragment filenames: same input, same page, every
// build.
//
// The first title on a date wins rather than the last. After a compaction the
// archive's entry for that date comes first, so a headline that has already
// shipped keeps reading the way people saw it, and a later fragment can't quietly
// rewrite it.
//
// Pure: sorts and copies, never mutates the input or the releases inside it.
export function mergeReleases(releases: ChangelogRelease[]): ChangelogRelease[] {
  const byDate = new Map<string, ChangelogRelease>();

  for (const rel of releases) {
    const existing = byDate.get(rel.date);
    if (!existing) {
      byDate.set(rel.date, {
        date: rel.date,
        ...(rel.title ? { title: rel.title } : {}),
        ...(rel.added?.length ? { added: [...rel.added] } : {}),
        ...(rel.changed?.length ? { changed: [...rel.changed] } : {}),
        ...(rel.fixed?.length ? { fixed: [...rel.fixed] } : {}),
      });
      continue;
    }
    if (rel.title && !existing.title) existing.title = rel.title;
    for (const key of ["added", "changed", "fixed"] as const) {
      const items = rel[key];
      if (!items?.length) continue;
      existing[key] = [...(existing[key] ?? []), ...items];
    }
  }

  return sortReleases([...byDate.values()]);
}
