// Folds settled changelog fragments into the archive and deletes them, so
// content/changelog.d/ stays a working tray rather than growing forever.
//
//   npm run changelog:compact              # fold anything older than 30 days
//   npm run changelog:compact -- --days 7
//   npm run changelog:compact -- --all
//
// HOUSEKEEPING, NOT A STEP. Nothing depends on this running: the page reads the
// archive and the fragments together either way, so skipping it costs a bigger
// directory and nothing else. That matters, because the moment it becomes
// required it is one more thing standing between a change and shipping it.
//
// Run it on its own PR. It rewrites content/changelog.json, which no ordinary PR
// touches anymore — so it conflicts with nothing, which is the same property the
// fragment split bought in the first place (see shared/changelog.ts).

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeReleases } from "../shared/changelog";
import { ARCHIVE_FILE, FRAGMENT_DIR, readArchive, readFragments } from "./changelogSources";

const argv = process.argv.slice(2);
let days = 30;
let all = false;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--all") {
    all = true;
  } else if (argv[i] === "--days") {
    const val = Number(argv[i + 1]);
    if (!Number.isInteger(val) || val < 0) fail("--days must be a whole number of days");
    days = val;
    i++;
  } else {
    fail(`unknown argument: ${argv[i]}`);
  }
}

// Local time, matching the ship-date semantics scripts/changelog.mjs writes with.
const cutoffMs = Date.now() - days * 86_400_000;
const cutoff = new Date(cutoffMs);
const pad = (n: number) => String(n).padStart(2, "0");
const cutoffIso = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;

const fragments = readFragments();
const settled = all ? fragments : fragments.filter((f) => f.release.date < cutoffIso);

if (!settled.length) {
  console.log(`✓ changelog: nothing to compact (${fragments.length} fragment(s), all newer than ${cutoffIso})`);
  process.exit(0);
}

// Archive first so a day that already shipped keeps its headline — see mergeReleases.
const merged = mergeReleases([...readArchive(), ...settled.map((f) => f.release)]);
writeFileSync(ARCHIVE_FILE, JSON.stringify(merged, null, 2) + "\n");

for (const f of settled) rmSync(join(FRAGMENT_DIR, f.name));

console.log(
  `✓ changelog: folded ${settled.length} fragment${settled.length === 1 ? "" : "s"} ${all ? "" : `older than ${cutoffIso} `}into the archive (${fragments.length - settled.length} left)`,
);

function fail(msg: string): never {
  console.error(`changelog: ${msg}`);
  process.exit(1);
}
