// The "What's new" changelog — the framework-agnostic type + ordering for the
// site's product changelog. The entries live in content/changelog.json (the one
// source of truth, updated as part of each user-facing PR); the page
// app/pages/changelog.vue renders them and scripts/changelog.mjs appends to
// them. Pure, so it unit-tests without Nuxt or a database.
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
