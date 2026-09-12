#!/usr/bin/env node
// `npm run typecheck`: regenerate Nuxt's types once, then check the three TypeScript
// projects side by side — app (what `nuxt typecheck` checks), scripts/ and tests/
// (which it never reaches; see tsconfig.scripts.json and tsconfig.tests.json).
//
// WHY a script and not `nuxt typecheck && vue-tsc … && vue-tsc …`: the three checks
// are independent, and each one is a single-threaded TypeScript program, so run in
// a chain they take the sum of their times and run together they take the longest
// one. The `nuxt prepare` stays sequential and first, deliberately — all three
// projects extend .nuxt/tsconfig.json, and `nuxt typecheck` rewrites that file (and
// .nuxt/*.d.ts) on its way in, so a checker that started alongside it could read a
// half-written file and report an error that isn't there. Generating once, then
// checking, is the same work in the same order minus the race.
//
// Each project is also incremental (tsconfig*.json → node_modules/.cache/typecheck/),
// so the second run after a small edit re-checks only what the edit touched.
// Measured on a 10-core machine at load ~5: the old chain 19s cold; this script 14s
// cold, 6s warm. The same chain measured 92s while three other checkouts were running
// their test suites — the load was most of the wait, which is why CI, not a local
// run, is the full gate (see CLAUDE.md). CI has no cache and pays the cold price
// every time; it's not the run anyone is waiting at a keyboard for.
//
//   npm run typecheck              all three
//   npm run typecheck -- tests     one or more by name: app, scripts, tests
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const vueTsc = require.resolve("vue-tsc/bin/vue-tsc.js");
// nuxt's `exports` map doesn't list its bin, so go through the manifest it does list
const nuxtPkg = require.resolve("nuxt/package.json");
const nuxt = resolve(dirname(nuxtPkg), require(nuxtPkg).bin.nuxt);

const PROJECTS = {
  app: "tsconfig.json",
  scripts: "tsconfig.scripts.json",
  tests: "tsconfig.tests.json",
};

const wanted = process.argv.slice(2);
const unknown = wanted.filter((name) => !(name in PROJECTS));
if (unknown.length) {
  console.error(`typecheck: unknown project ${unknown.join(", ")} (expected ${Object.keys(PROJECTS).join(", ")})`);
  process.exit(2);
}
const names = wanted.length ? wanted : Object.keys(PROJECTS);

/** Run a node script, resolving to its exit code and captured output. */
function run(script, args, { inherit = false } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      // nuxt prepare's own log line is fine to stream; the checkers are captured so
      // three of them can't interleave their error lists.
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
    });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

const started = Date.now();
const prepare = await run(nuxt, ["prepare"], { inherit: true });
if (prepare.code !== 0) process.exit(prepare.code);

const seconds = (from) => `${((Date.now() - from) / 1000).toFixed(1)}s`;
const results = await Promise.all(
  names.map(async (name) => {
    const from = Date.now();
    const { code, out } = await run(vueTsc, ["--noEmit", "-p", PROJECTS[name]]);
    // print as each finishes, so a failure shows while the slower ones still run
    const status = code === 0 ? "ok" : "FAILED";
    console.log(`typecheck: ${name} ${status} (${seconds(from)})`);
    if (out.trim()) console.log(out.trimEnd());
    return code;
  }),
);

const failed = results.filter((code) => code !== 0).length;
console.log(
  failed
    ? `typecheck: ${failed} of ${names.length} projects failed (${seconds(started)})`
    : `typecheck: ${names.length === 1 ? names[0] : `all ${names.length}`} passed (${seconds(started)})`,
);
process.exit(failed ? 1 : 0);
