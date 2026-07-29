#!/usr/bin/env node
// Brotli bundle-budget gate. The product shaves grams; the site shaves bytes.
//
// THE RATCHET IS FIRST LOAD — the JS/CSS a visitor to the editor actually
// downloads, read from the assets the prerendered /e references. Everything else
// in _nuxt (the /vault, /account, /about, /legal route chunks, the lazy modals
// and panes) is counted only against a deliberately loose TOTAL backstop.
//
// It used to gate on the sum of every built file, and that measured the wrong
// thing by a wide margin: on the vault + accounts work it reported +19.0 KB where
// a visitor downloaded +8.3 KB — 2.3× the real cost. Worse, the gap WAS the
// lazy-loading. Route-splitting a page and dynamically importing a pane bought
// nothing against the gate, so the guardrail actively taxed the optimisation the
// codebase is built around, and every new page was billed to people who never
// open it. Splitting the two numbers puts the incentive back the right way up:
// move code off the hot path and the ratchet falls.
//
// Run after `nuxt build`: `npm run build && npm run bundle-budget`.
// Budgets are a ratchet — set a little above current so a heavy dep or accidental
// client import trips the gate, not normal growth. Bump deliberately, with intent.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

// all client JS + CSS, brotli. Bumped 125→127 for nested items (an item can hold nested
// items — the same editable row one level down: catalog autocomplete, weight/qty/class,
// nest/un-nest, drag) landing on a main baseline already grown to ~124.5 by the changelog
// page + catalog search-terms. Bumped 127→128 for two interaction features: drag an item
// in/out of a nested group, and the mobile ⋯ overflow menu (a CircleEllipsis glyph + the
// per-row menu that tucks the note/nesting actions away on the crowded two-line row).
// Bumped 128→133 for the nuxt 4.4.8→4.5.0 client-runtime growth (~4.5 KB brotli); no app
// code changed, just the framework we ship.
//
// NOT a bump, but the reason current dropped ~2.4 KB: content/changelog.json used to be a
// module-scope import in the changelog page, so every entry was bundled into that
// route's client chunk. It's served from server/api/changelog.get.ts now (the page is
// prerendered, so the read happens at build time). That matters beyond the one-off saving
// — the house rule is a changelog entry per user-facing PR, so the old shape grew what
// this gate measures on PRs that ship no code at all, and the ratchet slowly became a
// tax on writing changelog entries. Watch for the same shape in any other checked-in
// content: import it in a server route, not a page.
//
// Bumped 133→134 to RE-ANCHOR after that shave, not to make room for anything. The shave
// left current at 132.9 against a 133 budget — 0.1 KB, which is below the noise floor
// (reflowing a comment in a .vue file can move it), so the gate would have failed on the
// next trivial change and been bumped reflexively. That is the failure this ratchet
// exists to avoid: a threshold nobody trusts gets raised on autopilot, and then it isn't
// a threshold. 134 restores roughly the ~1 KB gap the earlier anchors carried — enough
// that a heavy dep or a stray client import still trips it, but ordinary work doesn't.
//
// Bumped 134→136 for the trail link + the list-title block: a new list-level field
// threaded through the reducer, shared/trailLink.ts (URL guard + the name derived from a
// URL's path), ListHead.vue (the page title, its hover affordance, the link row), and the
// matching render on the two read views. ~2.0 KB brotli, measured — the gate caught it at
// 134.9 and this is the deliberate answer, not a nudge to make red go green. Worth noting
// what it did NOT cost: the favicons are fetched server-side and inlined as data: URLs
// into SSR HTML, which this gate doesn't measure at all, and the whole page-metadata
// scraper the feature originally implied was dropped rather than shipped to the client.
// 136 keeps the same ~1 KB working headroom the anchor is supposed to carry.
//
// Bumped 136→138 for the hover tooltip + the carried weight. Measured against the same
// build both ways: 135.6 KB before, 137.0 after, so +1.4 KB brotli. Most of that is the
// tooltip — a new shared component (Tooltip.vue: the flip/clamp positioning, the teleported
// popup) plus atoms/tooltip.scss and the two motion curves it brought with it, one of which
// is a 51-sample linear() spring. The carried weight itself is nearly free: one derived
// field on Totals, one chip, one line in the Markdown export. The tooltip is priced as
// infrastructure rather than as one feature — it exists to be reused, and the second and
// third consumer cost almost nothing on top of this. 138 restores the ~1 KB headroom.
//
// FIRST LOAD, the ratchet. 128.5 KB with the vault; 130 keeps the working headroom.
//
// Bumped 126→130 for the vault. This is the honest price of it: +6.7 KB on the hot
// path, paid by every visitor whether or not they ever open a vault, because
// useVaultToken, useVaultSearch and the vault rows in the item autocomplete all land
// in the editor chunk — the input offers your own gear alongside the catalog, so that
// part can't be lazy. Everything else IS: /vault is a route chunk, VaultPane and
// shared/vault.ts are dynamically imported, and the old whole-output gate would have
// charged another 4.6 KB for exactly that splitting. If the vault should cost the hot
// path less, the lever is the autocomplete integration, not the page.
const FIRST_LOAD_BUDGET_KB = 130;
// TOTAL of every built file, the backstop. Deliberately slack: its job is to catch
// a route chunk ballooning or a heavy dep landing somewhere unnoticed, NOT to price
// ordinary feature work. Set well clear of current (137.1) so it only speaks up when
// something has genuinely gone wrong. If you find yourself bumping this one often,
// something is being shipped to every page that shouldn't be.
const TOTAL_BUDGET_KB = 180;
const MAX_CHUNK_BUDGET_KB = 72; // largest single chunk, brotli (the framework runtime)

// First build output that exists: node-server, Vercel preset, or static generate.
const CANDIDATE_DIRS = [
  ".output/public/_nuxt",
  ".vercel/output/static/_nuxt",
  "dist/_nuxt",
];
const dir = CANDIDATE_DIRS.find((d) => existsSync(d));
if (!dir) {
  console.error("✗ No build output found — run `npm run build` first.");
  process.exit(1);
}

const brotli = (buf) =>
  brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const kb = (n) => (n / 1024).toFixed(1);

/**
 * The assets the editor's first load pulls — read from the prerendered /e HTML
 * (its <script>/<link> refs), which is exactly what the browser fetches before the
 * app is interactive. Falls back to null if the page isn't in the build output, in
 * which case the first-load gate is skipped rather than guessed at.
 */
function firstLoadAssets() {
  const html = [".output/public/e/index.html", ".vercel/output/static/e/index.html"]
    .filter(existsSync)
    .map((f) => readFileSync(f, "utf8"))[0];
  if (!html) return null;
  return new Set([...html.matchAll(/\/_nuxt\/([A-Za-z0-9_.-]+\.(?:js|css))/g)].map((m) => m[1]));
}

const files = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
const firstLoad = firstLoadAssets();
let totalRaw = 0;
let totalBr = 0;
let totalGz = 0;
const rows = [];
for (const f of files) {
  const buf = readFileSync(join(dir, f));
  const br = brotli(buf);
  const gz = gzipSync(buf, { level: 9 }).length;
  totalRaw += buf.length;
  totalBr += br;
  totalGz += gz;
  rows.push({ f, raw: buf.length, br, gz, first: firstLoad?.has(f) ?? false });
}
rows.sort((a, b) => b.br - a.br);

const firstBr = rows.filter((r) => r.first).reduce((n, r) => n + r.br, 0);
const firstBrKb = firstBr / 1024;
const totalBrKb = totalBr / 1024;
const maxChunk = rows[0] ?? { f: "—", br: 0 };
const maxChunkBrKb = maxChunk.br / 1024;

console.log(`Client bundle (${files.length} files from ${dir}):`);
for (const r of rows.slice(0, 8)) {
  console.log(
    `  ${(r.first ? "▸ " : "  ") + r.f.padEnd(28)} ${(kb(r.raw) + "KB").padStart(9)} raw → ${(kb(r.br) + "KB").padStart(8)} br`,
  );
}
if (rows.length > 8) console.log(`  …and ${rows.length - 8} more`);
console.log("");
console.log(`  (▸ = on the editor's first load)`);
console.log("");
if (firstLoad) {
  console.log(
    `  FIRST LOAD   : ${kb(firstBr)} KB brotli  (budget ${FIRST_LOAD_BUDGET_KB} KB)  ← the ratchet`,
  );
}
console.log(`  total raw    : ${kb(totalRaw)} KB`);
console.log(`  total gzip   : ${kb(totalGz)} KB`);
console.log(`  total brotli : ${kb(totalBr)} KB  (budget ${TOTAL_BUDGET_KB} KB)  ← backstop`);
console.log(
  `  largest chunk: ${kb(maxChunk.br)} KB brotli — ${maxChunk.f}  (budget ${MAX_CHUNK_BUDGET_KB} KB)`,
);
console.log("");

const failures = [];
if (firstLoad && firstBrKb > FIRST_LOAD_BUDGET_KB)
  failures.push(
    `first load ${kb(firstBr)} KB > ${FIRST_LOAD_BUDGET_KB} KB budget — this is what every visitor downloads`,
  );
if (!firstLoad)
  console.warn("  ! /e not in the build output — first-load gate skipped, total only.\n");
if (totalBrKb > TOTAL_BUDGET_KB)
  failures.push(`total brotli ${kb(totalBr)} KB > ${TOTAL_BUDGET_KB} KB budget`);
if (maxChunkBrKb > MAX_CHUNK_BUDGET_KB)
  failures.push(
    `largest chunk ${kb(maxChunk.br)} KB > ${MAX_CHUNK_BUDGET_KB} KB budget (${maxChunk.f})`,
  );

if (failures.length) {
  console.error("✗ Over budget:");
  for (const m of failures) console.error(`  - ${m}`);
  console.error("\n  Shave the bundle or bump the budget deliberately in scripts/bundle-budget.mjs.");
  process.exit(1);
}
console.log(
  `✓ Within budget — first load ${kb(firstBr)}/${FIRST_LOAD_BUDGET_KB} KB, total ${kb(totalBr)}/${TOTAL_BUDGET_KB} KB, largest ${kb(maxChunk.br)}/${MAX_CHUNK_BUDGET_KB} KB.`,
);
