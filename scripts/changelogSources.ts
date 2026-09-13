// Where the changelog's two halves live, and how to read them. Read-only: the
// release script, the compactor and the tests all come through here.
//
// content/changelog.json is history that only changelog:compact rewrites, and
// content/changelog.d/*.json is one file per PR. See shared/changelog.ts for why an
// entry is a file rather than a line in a shared one.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChangelogRelease } from "../shared/changelog";
import { isCalendarDate } from "../shared/calendar";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const ARCHIVE_FILE = join(root, "content", "changelog.json");
export const FRAGMENT_DIR = join(root, "content", "changelog.d");

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
  if (release.title != null && (typeof release.title !== "string" || !release.title.trim())) {
    throw new Error(`${source} has a blank or non-text "title".`);
  }

  let entries = 0;
  for (const group of ["added", "changed", "fixed"] as const) {
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

/** The compacted history. Always present — it is checked in. */
export function readArchive(): ChangelogRelease[] {
  const source = "content/changelog.json";
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ARCHIVE_FILE, "utf8"));
  } catch (e) {
    throw new Error(`${source} is not valid JSON (${(e as Error).message}).`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${source} must be a JSON array of releases.`);
  return parsed.map((release, index) => parseChangelogRelease(release, `${source} entry ${index + 1}`));
}

export interface Fragment {
  /** Bare filename, e.g. `2026-08-10-sort-folders-a1b2.json`. */
  name: string;
  release: ChangelogRelease;
}

/**
 * Every fragment, in filename order.
 *
 * Filename order is the whole ordering story for a day: names start with the
 * date and are otherwise fixed at the moment the entry is written, so the same
 * set of files always folds into the same page. Sorting by mtime or directory
 * order would let a checkout reshuffle a shipped day.
 *
 * A missing directory is normal, not an error — a repo with every entry
 * compacted into the archive has nothing here.
 */
export function readFragments(): Fragment[] {
  if (!existsSync(FRAGMENT_DIR)) return [];
  return readdirSync(FRAGMENT_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, release: readFragment(name) }));
}

/**
 * One fragment, with its filename in any complaint.
 *
 * The bare JSON.parse said only "Unexpected token }" — and because the build runs
 * from `postinstall`, that surfaced as a failed `npm install` with nothing pointing
 * at which of N files was malformed. A hand-edited or half-merged fragment is the
 * likely cause, so the message names it and says what to do.
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
