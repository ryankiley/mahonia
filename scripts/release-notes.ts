// The CLI behind .github/workflows/releases.yml. Reads the changelog's two halves
// (the archive and the fragments), never the generated file, so it needs no build.
//
//   npm run release-notes -- --list            # "date<TAB>tag" per settled release, oldest first
//   npm run release-notes -- --title 2026-09-12
//   npm run release-notes -- --body 2026-09-12
//
// "Settled" means the day is over in the changelog's timezone; today's release is
// still being written. Pass --today YYYY-MM-DD to pin the clock (tests, dry runs).

import { mergeReleases } from "../shared/changelog";
import { readArchive, readFragments } from "./changelogSources";
import { CHANGELOG_TZ, releaseBody, releaseTitle, settledReleases, tagFor, todayIn } from "./releaseNotes";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : undefined;
};

const releases = mergeReleases([...readArchive(), ...readFragments().map((f) => f.release)]);
const today = flag("--today") ?? todayIn(CHANGELOG_TZ);

if (args.includes("--list")) {
  for (const rel of settledReleases(releases, today)) console.log(`${rel.date}\t${tagFor(rel.date)}`);
} else if (flag("--title") || flag("--body")) {
  const date = flag("--title") ?? flag("--body")!;
  const rel = releases.find((r) => r.date === date);
  if (!rel) {
    console.error(`no changelog release dated ${date}`);
    process.exit(1);
  }
  process.stdout.write(flag("--title") ? `${releaseTitle(rel)}\n` : releaseBody(rel));
} else {
  console.error("usage: release-notes --list | --title DATE | --body DATE [--today DATE]");
  process.exit(2);
}
