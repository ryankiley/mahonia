#!/usr/bin/env node
// Appends an entry to the site's "What's new" changelog (content/changelog.json),
// so the plain-style, grouped format stays consistent when we ship a user-facing
// change. Content is checked-in JSON — never derived from git at build time,
// which is unreliable on Vercel's shallow clone.
//
// Usage:
//   npm run changelog -- --added "Sort folders by weight."
//   npm run changelog -- --fixed "…" --fixed "…" --changed "…"
//   npm run changelog -- --date 2026-07-16 --title "Big release" --added "…"
//
// --added / --changed / --fixed are repeatable. Bullets land under today's
// release (created if absent); --date overrides the date, --title sets/updates
// the batch headline. Newest release is kept first. Entries are hand-written
// (the PR author adds one per user-facing change) — never auto-generated, so the
// "What's new" page stays plain, user-facing prose.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "content", "changelog.json");

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

if (!groups.added.length && !groups.changed.length && !groups.fixed.length && !title) {
  fail("nothing to add — pass at least one --added / --changed / --fixed (or --title)");
}

// --- load, merge into the release for `date`, write back newest-first ---
const releases = JSON.parse(readFileSync(FILE, "utf8"));

let release = releases.find((r) => r.date === date);
if (!release) {
  release = { date };
  releases.push(release);
}
if (title) release.title = title;
for (const key of ["added", "changed", "fixed"]) {
  if (!groups[key].length) continue;
  release[key] = [...(release[key] ?? []), ...groups[key]];
}

// keep a stable key order per release: date, title, added, changed, fixed
const ordered = releases
  .map((r) => {
    const out = { date: r.date };
    if (r.title) out.title = r.title;
    for (const key of ["added", "changed", "fixed"]) if (r[key]?.length) out[key] = r[key];
    return out;
  })
  .sort((a, b) => b.date.localeCompare(a.date));

writeFileSync(FILE, JSON.stringify(ordered, null, 2) + "\n");

const added = groups.added.length + groups.changed.length + groups.fixed.length;
console.log(`✓ changelog: ${added} entr${added === 1 ? "y" : "ies"} on ${date}`);

function fail(msg) {
  console.error(`changelog: ${msg}`);
  process.exit(1);
}
