// Writes one entry for the changelog (published as a GitHub Release per day),
// so the plain-style, grouped format stays consistent when we ship a user-facing
// change. Content is checked-in JSON, hand-written, never derived from git.
//
// Usage:
//   npm run changelog -- --added "Sort folders by weight."
//   npm run changelog -- --fixed "…" --fixed "…" --changed "…"
//   npm run changelog -- --date 2026-07-16 --added "…"
//
// --added / --changed / --fixed are repeatable. --date overrides today. Entries
// are hand-written (the PR author adds one per user-facing change) — never
// auto-generated, so the changelog stays plain, user-facing prose.
//
// Each run writes a NEW FILE under content/changelog.d/, so two open PRs never
// edit the same lines. scripts/release-notes.ts folds the fragments back together
// for each day's release; scripts/changelogSources.ts has the full reasoning.
//
// Run through jiti like release-notes, so the directory, the calendar and the day
// are the ONE copy each of those already owns; a writer with its own spelling of
// the day can stamp one the reader settles on a different clock.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCalendarDate } from "../shared/calendar";
import { CHANGELOG_GROUPS, FRAGMENT_DIR, type ChangelogGroup, type ChangelogRelease } from "./changelogSources";
import { CHANGELOG_TZ, todayIn } from "./releaseNotes";

// --- parse args: repeatable --added/--changed/--fixed, single --date ---
const argv = process.argv.slice(2);
const groups: Record<ChangelogGroup, string[]> = { added: [], changed: [], fixed: [] };
// Changelog days are Pacific calendar days — the clock the release workflow
// settles them on — wherever this command happens to run.
let date = todayIn(CHANGELOG_TZ);

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  const val = argv[i + 1];
  if (arg === "--added" || arg === "--changed" || arg === "--fixed") {
    if (val === undefined) fail(`${arg} needs a value`);
    groups[arg.slice(2) as ChangelogGroup].push(val.trim());
    i++;
  } else if (arg === "--date") {
    if (!isCalendarDate(val)) fail("--date must be a real YYYY-MM-DD calendar date");
    date = val;
    i++;
  } else {
    fail(`unknown argument: ${arg}`);
  }
}

// Blank bullets are dropped rather than written: `--added "  "` would otherwise
// write `[""]`, which parseChangelogRelease rejects, so the CLI would print ✓
// over something that turns the next PR red.
for (const key of CHANGELOG_GROUPS) {
  groups[key] = groups[key].filter((s) => s.length > 0);
}

// At least one BULLET, not merely one flag: a fragment with nothing in it is a
// release with an empty body, and the parser rejects it.
if (!groups.added.length && !groups.changed.length && !groups.fixed.length) {
  fail("nothing to add — pass at least one --added / --changed / --fixed");
}

// --- build the fragment: a release object, the shape the release script reads ---
const fragment: ChangelogRelease = { date };
for (const key of CHANGELOG_GROUPS) {
  if (groups[key].length) fragment[key] = groups[key];
}

const body = JSON.stringify(fragment, null, 2) + "\n";

// The filename has to be unique WITHOUT knowing what any other branch is doing —
// that's the whole point. The date sorts a day's entries together, the slug makes
// the directory readable at a glance, and a hash of the content settles the rest:
// two branches writing different entries get different names, and two writing the
// identical entry produce the identical file, which git merges rather than
// conflicts on.
//
// The hash carries the whole burden, because date+slug collide REGULARLY — the
// slug is six words of one bullet, and this project ships batches of closely
// related sentences. There is already a same-day pair in the changelog whose first
// six words match ("When a list's gear is already reaching My Gear on its own…").
// 4 hex chars is 16 bits, which is a coin-flip-scale collision across a few
// thousand entries and would have silently overwritten one of them; 12 is 48 bits,
// which is not going to happen. The local guard below can only see this branch, so
// the hash length is what protects the cross-branch case.
const first = groups.added[0] ?? groups.changed[0] ?? groups.fixed[0] ?? "";
const slug =
  first
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-")
    .slice(0, 48) || "entry";
const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
const name = `${date}-${slug}-${hash}.json`;
const path = join(FRAGMENT_DIR, name);

mkdirSync(FRAGMENT_DIR, { recursive: true });
// Never write over an entry that isn't this one. Same content = the same command
// run twice, so that stays a no-op; different content behind the same name is a
// hash collision, and losing somebody's sentence to it in silence is the one
// outcome worth stopping the world for.
if (existsSync(path) && readFileSync(path, "utf8") !== body) {
  fail(`${name} already exists with different content — reword the entry slightly and re-run`);
}
writeFileSync(path, body);

const count = groups.added.length + groups.changed.length + groups.fixed.length;
console.log(`✓ changelog: ${count} entr${count === 1 ? "y" : "ies"} on ${date} → content/changelog.d/${name}`);

function fail(msg: string): never {
  console.error(`changelog: ${msg}`);
  process.exit(1);
}
