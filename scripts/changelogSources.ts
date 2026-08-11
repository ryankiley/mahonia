// Where the changelog's two halves live, and how to read them.
//
// Split out from build-changelog.ts so importing this costs nothing — the build
// script writes a file when you run it, and tests/changelog.test.ts wants the
// same reader without that. Everything here is read-only.
//
// The archive is checked in and the generated file is not: content/changelog.json
// is history that only changelog:compact rewrites, content/changelog.d/*.json is
// one file per PR, and content/changelog.generated.json is what the build folds
// them into for server/api/changelog.get.ts to import. See shared/changelog.ts
// for why an entry is a file rather than a line in a shared one.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChangelogRelease } from "../shared/changelog";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const ARCHIVE_FILE = join(root, "content", "changelog.json");
export const FRAGMENT_DIR = join(root, "content", "changelog.d");
export const GENERATED_FILE = join(root, "content", "changelog.generated.json");

/** The compacted history. Always present — it is checked in. */
export function readArchive(): ChangelogRelease[] {
  return JSON.parse(readFileSync(ARCHIVE_FILE, "utf8")) as ChangelogRelease[];
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
    .map((name) => ({
      name,
      release: JSON.parse(readFileSync(join(FRAGMENT_DIR, name), "utf8")) as ChangelogRelease,
    }));
}
