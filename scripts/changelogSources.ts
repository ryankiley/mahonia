// The changelog: what an entry is, where entries live, and how they fold into one
// release per day (published as GitHub Releases by .github/workflows/releases.yml).
// The writer, the release script and the tests all come through here.
//
// An entry is a file of its own under content/changelog.d/, one per PR and only ever
// added, because two open PRs cannot conflict on files neither of them shares. One
// shared file conflicted on the same few lines whenever two PRs were open at once.
//
// Entries are written per PR by a person, never generated. A changelog-reminder comment
// nudges a user-facing PR that is missing one, but nothing scrapes the PR title; a
// forgotten entry is simply absent from that day's release until it is backfilled.
// House style: one plain user-facing sentence, the observable change and not the
// implementation, grouped Keep-a-Changelog style.
//
// Dates are checked-in content, never derived from git, whose per-file history is
// wrong in a shallow clone.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isCalendarDate } from "../shared/calendar";
import { ROOT } from "./paths";

export const FRAGMENT_DIR = join(ROOT, "content", "changelog.d");

export interface ChangelogRelease {
  /** ISO date (YYYY-MM-DD) the change shipped. */
  date: string;
  /** Plain, user-facing entries, grouped Added / Changed / Fixed. */
  added?: string[];
  changed?: string[];
  fixed?: string[];
}

/** The entry groups, in the order a release lists them. The writer, the validator,
 *  the merge and the release body all walk this one list. */
export const CHANGELOG_GROUPS = ["added", "changed", "fixed"] as const;
export type ChangelogGroup = (typeof CHANGELOG_GROUPS)[number];

/**
 * Validate one checked-in release before it reaches the merge/release path. It is
 * intentionally stricter than a type assertion: malformed JSON content otherwise
 * fails several layers later as an opaque `rel[key] is not iterable` or, worse,
 * turns an impossible date into a neighboring day when its release title renders.
 */
export function parseChangelogRelease(value: unknown, source: string): ChangelogRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be an object.`);
  }
  const release = value as Record<string, unknown>;
  if (!isCalendarDate(release.date)) {
    throw new Error(`${source} has no valid "date" (expected a real YYYY-MM-DD calendar date).`);
  }

  let entries = 0;
  for (const group of CHANGELOG_GROUPS) {
    const values = release[group];
    if (values == null) continue;
    if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error(`${source} has a non-text or blank entry in "${group}".`);
    }
    entries += values.length;
  }
  if (!entries) throw new Error(`${source} needs at least one added, changed, or fixed entry.`);
  // The checks above establish the runtime shape; TypeScript cannot retain that
  // fact across Record's dynamic keys, so bridge through unknown at this boundary.
  return release as unknown as ChangelogRelease;
}

interface Fragment {
  /** Bare filename, e.g. `2026-08-10-sort-folders-a1b2.json`. */
  name: string;
  release: ChangelogRelease;
}

/**
 * Every fragment, in filename order.
 *
 * Filename order is the whole ordering story for a day: names start with the
 * date and are otherwise fixed at the moment the entry is written, so the same
 * set of files always folds into the same release. Sorting by mtime or directory
 * order would let a checkout reshuffle a shipped day.
 *
 * A missing directory reads as no entries.
 */
export function readFragments(): Fragment[] {
  if (!existsSync(FRAGMENT_DIR)) return [];
  return readdirSync(FRAGMENT_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, release: readFragment(name) }));
}

/**
 * One fragment, with its filename in any complaint. A bare JSON.parse error says
 * only "Unexpected token }", with nothing pointing at which of the files is
 * malformed. A hand-edited or half-merged fragment is the likely cause, so the
 * message names it and says what to do.
 */
function readFragment(name: string): ChangelogRelease {
  const raw = readFileSync(join(FRAGMENT_DIR, name), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `content/changelog.d/${name} is not valid JSON (${(e as Error).message}). ` +
        `Fragments are written by \`npm run changelog\`; if this one was hand-edited or came out of a merge, fix or delete it.`,
    );
  }
  return parseChangelogRelease(parsed, `content/changelog.d/${name}`);
}

// Fold many releases into one per date. A day is usually several fragments (five PRs
// shipped on Tuesday are five files that have to read as one Tuesday), so each group's
// entries concatenate in the order given, which readFragments fixes by filename: same
// files, same release, every run. The days come back in the order they first appear;
// settledReleases sorts the ones the release workflow cuts.
//
// Pure: never mutates the input or the releases inside it.
export function mergeReleases(releases: ChangelogRelease[]): ChangelogRelease[] {
  const byDate = new Map<string, ChangelogRelease>();
  for (const rel of releases) {
    let day = byDate.get(rel.date);
    if (!day) byDate.set(rel.date, (day = { date: rel.date }));
    for (const key of CHANGELOG_GROUPS) {
      if (rel[key]?.length) day[key] = [...(day[key] ?? []), ...rel[key]];
    }
  }
  return [...byDate.values()];
}
