// The bundle report: what bundle-budget.mjs writes with `--report=` and what
// bundle-delta.mjs reads back — the one place the two agree on its shape and on how
// a byte count is shown. Plain .mjs, so both CLIs import it with no transpiler
// (the changelog scripts keep a duplicate for the opposite reason: one is TypeScript).

import { readFileSync } from "node:fs";

/** bytes → "12.3" (KiB, one decimal) — the same figure on the CI log and the receipt */
export const kb = (n) => (n / 1024).toFixed(1);

/** Every key a report carries. `firstLoad` is null when /e wasn't in the build;
 *  the two `*Sources` maps are null when the build carried no hidden sourcemaps. */
export const REPORT_KEYS = ["firstLoad", "total", "maxChunk", "budgets", "files", "firstLoadSources", "totalSources"];

/**
 * Read a report and refuse one that isn't — a missing file, a file that isn't JSON,
 * or a JSON that lacks a key. The delta's "no per-source attribution" line used to
 * be the only symptom of a renamed field; a thrown error names the file and the key.
 */
export function loadReport(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`bundle report ${path}: cannot read (${e.code ?? e.message})`);
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error(`bundle report ${path}: not JSON`);
  }
  for (const key of REPORT_KEYS) {
    if (!(key in report)) throw new Error(`bundle report ${path}: missing "${key}" — written by an older bundle-budget.mjs?`);
  }
  return report;
}
