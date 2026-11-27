#!/usr/bin/env node
// Stamps "Last updated <date>" on the legal pages so the date tracks the change
// itself instead of anyone remembering to bump it. Runs from .githooks/pre-commit
// (wired by scripts/setup-git-hooks.mjs on npm install): a staged legal page whose
// WORDS changed gets today's date written in and re-staged before the commit lands.
//
// The words, not the file. It stamped on any staged change at first, and a rename of
// the CSS variables in the page's <style> block moved the date two days on with the
// terms untouched: a reader was told the terms had changed when they had not. What a
// reader sees is the <template>, so that is what is compared against the last commit,
// with the date line itself left out of the comparison so that correcting a date by
// hand is not itself a reason to stamp today's over it.
//
// The date can't be derived at build time — Vercel builds from a shallow clone
// (depth 10, no remote), where `git log -1 -- <file>` reports the shallow-
// boundary commit for anything older and would bake a wrong date into the
// prerendered page. Stamping at commit time makes the date plain checked-in
// content, correct in any build environment.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PAGES = ["app/pages/legal.vue"];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

// US order, as every other date the app shows: "July 12, 2026"
const today = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
}).format(new Date());

const DATE_LINE = /Last updated [^<]*/;
/** What a reader of the page sees: its <template>, less the date this script writes. */
const words = (source) => (source.match(/<template>[\s\S]*<\/template>/)?.[0] ?? source).replace(DATE_LINE, "");

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
  // a page with no earlier version is new words by definition
  let committed = null;
  try {
    committed = git("show", `HEAD:${page}`);
  } catch {}
  if (committed !== null && words(committed) === words(source)) continue;
  const stamped = source.replace(DATE_LINE, `Last updated ${today}`);
  if (stamped === source) continue;
  writeFileSync(page, stamped);
  git("add", "--", page);
  console.log(`✓ ${page}: Last updated ${today}`);
}
