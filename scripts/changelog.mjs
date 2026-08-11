#!/usr/bin/env node
// Writes one entry for the site's "What's new" changelog (app/pages/about.vue),
// so the plain-style, grouped format stays consistent when we ship a user-facing
// change. Content is checked-in JSON — never derived from git at build time,
// which is unreliable on Vercel's shallow clone.
//
// Usage (unchanged):
//   npm run changelog -- --added "Sort folders by weight."
//   npm run changelog -- --fixed "…" --fixed "…" --changed "…"
//   npm run changelog -- --date 2026-07-16 --title "Big release" --added "…"
//
// --added / --changed / --fixed are repeatable. --date overrides today, --title
// sets the batch headline. Entries are hand-written (the PR author adds one per
// user-facing change) — never auto-generated, so the "What's new" page stays
// plain, user-facing prose.
//
// This writes a NEW FILE under content/changelog.d/ rather than appending to
// content/changelog.json. Appending is what it used to do, and it meant every PR
// shipped on the same day edited the same release object at the top of the same
// file — so two open PRs conflicted on the same handful of lines, every time (28
// commits touched that file on one day). Two PRs can't conflict on files neither
// of them shares. scripts/build-changelog.ts folds the fragments back together
// for the page; shared/changelog.ts has the full reasoning.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Kept in step with FRAGMENT_DIR in scripts/changelogSources.ts by hand: this
// file is plain .mjs so `npm run changelog` stays a bare node call with no
// transpiler between you and the argument list, which means it can't import the
// TypeScript that owns the path. One string, named in both places on purpose.
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "content", "changelog.d");

// today, in LOCAL time (matches the ship-date semantics of the entries)
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

// --- parse args: repeatable --added/--changed/--fixed, single --date/--title ---
const argv = process.argv.slice(2);
const groups = { added: [], changed: [], fixed: [] };
let date = todayIso;
let title;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const val = argv[i + 1];
  if (arg === "--added" || arg === "--changed" || arg === "--fixed") {
    if (val === undefined) fail(`${arg} needs a value`);
    groups[arg.slice(2)].push(val.trim());
    i++;
  } else if (arg === "--date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val ?? "")) fail("--date must be YYYY-MM-DD");
    date = val;
    i++;
  } else if (arg === "--title") {
    if (val === undefined) fail("--title needs a value");
    title = val.trim();
    i++;
  } else {
    fail(`unknown argument: ${arg}`);
  }
}

// Blank bullets are dropped rather than written. `--added "  "` used to pass the
// check below (length 1) and write `[""]`, which the content gate in
// tests/changelog.test.ts then failed — the CLI printing ✓ over something that
// turns the next PR red.
for (const key of ["added", "changed", "fixed"]) {
  groups[key] = groups[key].filter((s) => s.length > 0);
}

// At least one BULLET, not merely one flag. A title-only fragment is a release
// with nothing in it: the same content gate rejects it, and app/pages/about.vue
// would render a dated heading with an empty body. --title still works, alongside
// the bullets it is a headline for.
if (!groups.added.length && !groups.changed.length && !groups.fixed.length) {
  fail(
    title
      ? "--title is a headline for a batch, so it needs at least one --added / --changed / --fixed beside it"
      : "nothing to add — pass at least one --added / --changed / --fixed",
  );
}

// --- build the fragment: a release object, same shape the page already reads ---
const fragment = { date };
if (title) fragment.title = title;
for (const key of ["added", "changed", "fixed"]) {
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
// related sentences. There is already a same-day pair in the archive whose first
// six words match ("When a list's gear is already reaching My Gear on its own…").
// 4 hex chars is 16 bits, which is a coin-flip-scale collision across a few
// thousand entries and would have silently overwritten one of them; 12 is 48 bits,
// which is not going to happen. The local guard below can only see this branch, so
// the hash length is what protects the cross-branch case.
const first = groups.added[0] ?? groups.changed[0] ?? groups.fixed[0] ?? title;
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
const path = join(DIR, name);

mkdirSync(DIR, { recursive: true });
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

function fail(msg) {
  console.error(`changelog: ${msg}`);
  process.exit(1);
}
