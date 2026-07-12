#!/usr/bin/env node
// Stamps "Last updated <date>" on the legal pages so the date tracks the change
// itself instead of anyone remembering to bump it. Runs from .githooks/pre-commit
// (wired by scripts/setup-git-hooks.mjs on npm install): any staged legal page
// gets today's date written in and re-staged before the commit lands.
//
// The date can't be derived at build time — Vercel builds from a shallow clone
// (depth 10, no remote), where `git log -1 -- <file>` reports the shallow-
// boundary commit for anything older and would bake a wrong date into the
// prerendered page. Stamping at commit time makes the date plain checked-in
// content, correct in any build environment.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PAGES = ["app/pages/privacy.vue", "app/pages/terms.vue"];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// matches the pages' existing format: "12 July 2026"
const today = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
}).format(new Date());

const staged = new Set(git("diff", "--cached", "--name-only").split("\n"));

for (const page of PAGES) {
  if (!staged.has(page)) continue;
  // Partially staged: re-adding after the stamp would sweep the unstaged edits
  // into the commit. Leave it alone and let the author sort the date out.
  if (git("diff", "--name-only", "--", page) !== "") {
    console.warn(`⚠ ${page} has unstaged changes — not stamping "Last updated".`);
    continue;
  }
  const source = readFileSync(page, "utf8");
  const stamped = source.replace(/Last updated [^<]*/, `Last updated ${today}`);
  if (stamped === source) continue;
  writeFileSync(page, stamped);
  git("add", "--", page);
  console.log(`✓ ${page}: Last updated ${today}`);
}
