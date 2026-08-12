// Folds the changelog archive and every per-PR fragment into one file for the
// app to read: content/changelog.generated.json.
//
// Runs automatically — npm's `pre` hooks fire it before dev, build, test and
// typecheck, and postinstall makes a fresh clone work before any of those. So
// nobody has to remember it, and `npm run changelog` doesn't have to build
// anything to make an entry show up locally.
//
// The output is gitignored ON PURPOSE. Checking it in would put every PR back to
// editing one shared file, which is the exact conflict the fragment split exists
// to remove (see shared/changelog.ts).

import { readFileSync, writeFileSync } from "node:fs";
import { mergeReleases } from "../shared/changelog";
import { GENERATED_FILE, readArchive, readFragments } from "./changelogSources";

const fragments = readFragments();

// Archive first, fragments in filename order — mergeReleases keeps that order
// within a date, and prefers the archive's title for a day that already shipped.
const merged = mergeReleases([...readArchive(), ...fragments.map((f) => f.release)]);

const next = JSON.stringify(merged, null, 2) + "\n";

// Only write when something actually changed. `predev` runs this on every dev
// start, and rewriting an identical file would touch its mtime and bounce Nuxt's
// watcher for no reason.
let current = "";
try {
  current = readFileSync(GENERATED_FILE, "utf8");
} catch {
  // not built yet — first run, or a fresh clone
}

if (current !== next) writeFileSync(GENERATED_FILE, next);

console.log(
  `✓ changelog: ${merged.length} release${merged.length === 1 ? "" : "s"} from the archive + ${fragments.length} fragment${fragments.length === 1 ? "" : "s"}`,
);
