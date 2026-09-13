#!/usr/bin/env node
// Brotli bundle-budget gate. The product shaves grams; the site shaves bytes.
//
// THE NUMBER THAT MATTERS IS FIRST LOAD — the JS/CSS a visitor to the editor actually
// downloads, read from the assets the prerendered /e references. Everything else in
// _nuxt (the /gear, /account, /about, /legal route chunks, the lazy modals, menus and
// panes) is counted only against a deliberately loose TOTAL backstop.
//
// It used to gate on the sum of every built file, and that measured the wrong thing
// by a wide margin: route-splitting a page and dynamically importing a pane bought
// nothing against the gate, so the guardrail actively taxed the optimisation the
// codebase is built around. Splitting the two numbers puts the incentive back the
// right way up: move code off the hot path and the first-load number falls.
//
// FIRST LOAD HAS TWO LINES, because one number was being asked to do two jobs and
// could only do one of them:
//
//   the CEILING  — a product decision. What the editor may cost every visitor, full
//                  stop. It is NOT re-anchored when a feature lands over it: the
//                  feature shaves in the same PR, or makes the product case for a
//                  heavier editor and moves the ceiling with that case written down.
//                  Moves for a framework major, or a decision — never for "the row
//                  grew a button".
//   the TRIPWIRE — an accident detector, ~2 KB above the last measurement. A heavy
//                  dependency, a stray static import of something meant to be lazy,
//                  a checked-in JSON riding a page: all trip it before they reach the
//                  ceiling. Re-anchor it freely, in the PR that spends it, to current
//                  + ~2 — no essay: CI posts every PR's delta against main, by source,
//                  and that comment is the record.
//
// For eleven weeks the tripwire was the only line, and it was raised twenty-one times
// with a paragraph each and lowered twice — scripts/bundle-budget-ledger.md keeps every
// one of those paragraphs. They are good history and they were never a "no"; the
// ceiling is.
//
// Run after `nuxt build`: `npm run build && npm run bundle-budget`. With
// `--report=<path>` it also writes the measurement as JSON — per file, and per source
// when the build carried hidden sourcemaps (CI's does: BUNDLE_MAPS=1, see nuxt.config)
// — which is what scripts/bundle-delta.mjs diffs against main's.

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import { kb } from "./bundleReport.mjs";

// THE CEILING. 150 KB brotli for the editor's first load, set 2026-09-12 at 146.6
// measured, after a menu left the hot path and the icon set lost its fourth decimal.
// Of that 146.6: 66 KB is the framework (vue, nuxt, vue-router, unhead, ofetch —
// the floor, movable only by a framework change), 14 KB is CSS, 8 KB is glyphs,
// 54 KB is the product, and the rest is chunk glue. The product's share had grown
// from ~48 to ~80 KB in the seven weeks before this line was drawn (118.6 → 151.1
// on this number, net of a 10 KB delivery pass), which is the growth the line
// exists to price.
//
// When it bites, the levers in order: a surface that only opens on a click goes
// Lazy (the shape every modal, the ⋯ menu and the panes already have); an icon
// sprite as a static asset (~8 KB off this number, cached across deploys, and a
// third of the row's DOM with it); the account and vault machinery behind a
// signed-in check (~4 KB an anonymous visitor never needs). Beyond those it is a
// product conversation, and this is the number that starts it.
const FIRST_LOAD_CEILING_KB = 150;
// THE TRIPWIRE, ~2 KB over the last measurement. Re-anchor to current + ~2 in the
// PR that spends it; keep it under the ceiling.
//
// ON THE CEILING since the evening of 2026-09-12: main measured 149.0 against 149,
// the 2.4 KB above the 146.6 the ceiling was drawn at spent by a dozen PRs at 0.1
// to 0.3 KB each — none an accident, so none tripped it, which is the drift a
// tripwire cannot see. "Current + ~2" would be 151, so the two lines coincide
// until one of the levers above buys the margin back; until then a PR over 150
// meets the ceiling's message, not this one's.
const FIRST_LOAD_BUDGET_KB = 150;
// TOTAL of every built file, the backstop. Deliberately slack: its job is to catch
// a route chunk ballooning or a heavy dep landing somewhere unnoticed, NOT to price
// ordinary feature work. Set ~6 KB clear of the current total (281.9) so it only
// speaks up when something has genuinely gone wrong. If you find yourself bumping
// this one often, something is being shipped to every page that shouldn't be.
const TOTAL_BUDGET_KB = 288;
// Largest single chunk, brotli. LOAD-BEARING, and the one number here that should not move
// to accommodate a dependency: it is what a heavy map library fails. MapLibre GL ships as a
// single ~200 KB brotli chunk and was ruled out on this line alone — a dep that needs the
// budget tripled is precisely what the budget is for. Leaflet lands at 36.5 KB, half of it,
// which is why it was the one that could be taken. Unchanged by the map work.
// Since the boot-graph merge the largest chunk is the framework runtime (`vendor`,
// 52.9 KB, vue + vue-router + unhead + ofetch and friends), not Leaflet — a 52.9 KB
// chunk that every page needs before it can render anything, which is exactly what the
// cap is NOT for. Unchanged at 72: a heavy map library still fails it, and the vendor
// chunk only moves on a dependency bump.
const MAX_CHUNK_BUDGET_KB = 72;

// First build output that exists: node-server / static generate, or the Vercel
// preset. (No dist/: that's a Nuxt 2 layout this repo can't produce — and
// firstLoadAssets below has no dist/ entry, so a dist/ hit would have silently
// skipped the first-load ratchet.)
const CANDIDATE_DIRS = [
  ".output/public/_nuxt",
  ".vercel/output/static/_nuxt",
];
const dir = CANDIDATE_DIRS.find((d) => existsSync(d));
if (!dir) {
  console.error("✗ No build output found — run `npm run build` first.");
  process.exit(1);
}

const brotli = (buf) =>
  brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

/**
 * The assets the editor's first load pulls — read from the prerendered /e HTML,
 * which is exactly what the browser fetches before the app is interactive.
 *
 * BLOCKING REFS ONLY. The HTML points at files in two quite different voices:
 * <script src>, rel="modulepreload", rel="stylesheet" and rel="preload" mean
 * "I can't start without this"; rel="prefetch" means "fetch this at idle,
 * later, in case it's wanted". Only the first kind is first load.
 *
 * This used to be one regex over the whole document, which counted both — 15
 * prefetched files, ~11 KB brotli, among them VaultPane.css, ImportModal.css and
 * CatalogCorrectionModal.css. That contradicted this file's own header (lazy panes
 * and modals belong to the TOTAL backstop) and, worse, inverted the incentive the
 * split exists to create: making the vault pane lazy is supposed to move its weight
 * off the ratchet, but with its prefetch still counted it earned nothing, and every
 * KB the lazy pane grew was billed to first load anyway.
 *
 * Falls back to null if the page isn't in the build output, in which case the
 * first-load gate is skipped rather than guessed at.
 */
function firstLoadAssets() {
  const html = [".output/public/e/index.html", ".vercel/output/static/e/index.html"]
    .filter(existsSync)
    .map((f) => readFileSync(f, "utf8"))[0];
  if (!html) return null;
  const assets = new Set();
  const add = (href) => href && assets.add(href);
  const asset = (tag) => (tag.match(/\/_nuxt\/([A-Za-z0-9_.-]+\.(?:js|css))/) || [])[1];
  for (const [tag] of html.matchAll(/<script\b[^>]*\bsrc=[^>]*>/g)) add(asset(tag));
  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    const rel = (tag.match(/\brel="([^"]+)"/) || [])[1] || "";
    if (rel === "modulepreload" || rel === "stylesheet" || rel === "preload") add(asset(tag));
  }
  return assets;
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
  rows.push({ f, buf, raw: buf.length, br, first: firstLoad?.has(f) ?? false });
}
rows.sort((a, b) => b.br - a.br);

const firstBr = rows.filter((r) => r.first).reduce((n, r) => n + r.br, 0);
const firstBrKb = firstBr / 1024;
const totalBrKb = totalBr / 1024;
const maxChunk = rows[0] ?? { f: "—", br: 0 };
const maxChunkBrKb = maxChunk.br / 1024;

/**
 * Where the bytes come from, by source — when the build carried hidden client
 * sourcemaps (BUNDLE_MAPS=1 → nuxt.config's sourcemap.client). Chunk names are
 * hashes, so a per-file delta says "the 29 KB chunk grew 1.1 KB", which is nothing;
 * a per-source one says "ItemRow.vue +0.8, the icon set +0.3", which is something a
 * reviewer can act on. Hidden maps leave the JS byte-identical, so the numbers above
 * don't move with them (a local build without maps simply reports no attribution).
 *
 * EVERY BYTE IS CHARGED TO SOMETHING, so the rows sum to the totals they explain:
 * a mapped chunk's segments go to their source files, the bytes before a line's
 * first segment and on lines with no segment (the `import{…}from` headers and the
 * preload tables the bundler writes, which grow with the chunk graph) to "(glue)",
 * a CSS file to `css:<its stem>` (a .css has no map, but its name is stable across
 * hashes), and a script with no map to "(unmapped chunk)". Without this the receipt
 * could say "+1.5 KB" up top and "nothing moved" underneath — the CSS-only change.
 *
 * A source's brotli is estimated at its chunk's own compression ratio — an
 * estimate, and a fair one: a file compresses about the same whichever chunk it
 * lands in. Each chunk is walked once; first-load and total are two sums over it.
 */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(str) {
  const out = [];
  let shift = 0;
  let value = 0;
  for (const ch of str) {
    let digit = B64.indexOf(ch);
    const more = digit & 32;
    digit &= 31;
    value += digit << shift;
    if (more) {
      shift += 5;
      continue;
    }
    out.push(value & 1 ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }
  return out;
}

// A source path → the name a reviewer reads. node_modules collapse to the package;
// the repo's own files keep their path from the repo root; the bundler's virtual
// modules and Nuxt's generated ones are "(virtual)". Matched anywhere in the path,
// not at its start: a source is usually `../../app/…`, but a build whose
// node_modules is a symlink (a scratch worktree) records the absolute target.
function sourceName(s) {
  if (s.startsWith("(") || s.startsWith("css:")) return s;
  const pkg = s.match(/node_modules\/(?:\.cache\/[^/]+\/)?((?:@[^/]+\/)?[^/]+)/);
  if (pkg) return `npm:${pkg[1]}`;
  if (/^virtual:|^\0|^#|(?:^|\/)\.nuxt\//.test(s)) return "(virtual)";
  const own = s.replace(/\?.*$/, "").replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
  // an absolute path outside the repo we can't place: keep its last three segments
  return own.startsWith("/") ? own.split("/").slice(-3).join("/") : own;
}

// bytes per source for ONE built file, at that file's compression ratio
function chunkSources(r) {
  const ratio = r.br / r.raw;
  const out = new Map();
  const charge = (src, raw) => out.set(src, (out.get(src) ?? 0) + raw * ratio);
  if (r.f.endsWith(".css")) {
    charge(`css:${r.f.replace(/\.[A-Za-z0-9_-]{8}\.css$/, "")}`, r.raw);
    return { sources: out, mapped: false };
  }
  const mapPath = join(dir, r.f + ".map");
  if (!existsSync(mapPath)) {
    charge("(unmapped chunk)", r.raw);
    return { sources: out, mapped: false };
  }
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  if (typeof map.mappings !== "string" || !Array.isArray(map.sources)) throw new Error(`${r.f}.map has no mappings`);
  const lines = r.buf.toString("utf8").split("\n");
  let srcIdx = 0;
  map.mappings.split(";").forEach((line, li) => {
    const lineLen = (lines[li] ?? "").length + 1;
    const cols = [];
    let genCol = 0;
    for (const seg of line.split(",")) {
      if (!seg) continue;
      const v = vlq(seg);
      genCol += v[0];
      if (v.length >= 4) srcIdx += v[1];
      cols.push({ col: genCol, src: v.length >= 4 ? map.sources[srcIdx] : null });
    }
    // the run before the first segment — or the whole line, when it has none
    charge("(glue)", Math.min(cols.length ? cols[0].col : lineLen, lineLen));
    for (let i = 0; i < cols.length; i++) {
      const end = i + 1 < cols.length ? cols[i + 1].col : lineLen;
      charge(cols[i].src ?? "(glue)", Math.max(0, end - cols[i].col));
    }
  });
  return { sources: out, mapped: true };
}

/**
 * { firstLoadSources, totalSources } — each a name → brotli-bytes map sorted by
 * size, or both null when no chunk carried a map (a build without BUNDLE_MAPS).
 *
 * NEVER THE GATE'S PROBLEM. A map that won't parse, or a shape this walker doesn't
 * expect, costs the receipt its per-source rows and nothing else: the budget is
 * decided on the files' own bytes, above, and the report is still written. Before
 * this a broken map on a push to main failed the check and uploaded no baseline.
 */
function attribute() {
  try {
    const first = new Map();
    const total = new Map();
    let mapped = false;
    for (const r of rows) {
      const c = chunkSources(r);
      mapped ||= c.mapped;
      for (const [src, br] of c.sources) {
        const name = sourceName(src);
        total.set(name, (total.get(name) ?? 0) + br);
        if (r.first) first.set(name, (first.get(name) ?? 0) + br);
      }
    }
    if (!mapped) return { firstLoadSources: null, totalSources: null };
    const sorted = (m) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)]));
    return { firstLoadSources: firstLoad ? sorted(first) : null, totalSources: sorted(total) };
  } catch (e) {
    console.warn(`  ! per-source attribution skipped: ${e.message}\n`);
    return { firstLoadSources: null, totalSources: null };
  }
}

const reportPath = (process.argv.find((a) => a.startsWith("--report=")) ?? "").slice(9);
if (reportPath) {
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        firstLoad: firstLoad ? firstBr : null,
        total: totalBr,
        maxChunk: { file: maxChunk.f, br: maxChunk.br },
        budgets: { ceiling: FIRST_LOAD_CEILING_KB, firstLoad: FIRST_LOAD_BUDGET_KB, total: TOTAL_BUDGET_KB, maxChunk: MAX_CHUNK_BUDGET_KB },
        files: rows.map((r) => ({ file: r.f, br: r.br, first: r.first })),
        // bytes by source on the first load, and across every chunk — both brotli
        ...attribute(),
      },
      null,
      2,
    ) + "\n",
  );
}

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
    `  FIRST LOAD   : ${kb(firstBr)} KB brotli  (tripwire ${FIRST_LOAD_BUDGET_KB} KB · ceiling ${FIRST_LOAD_CEILING_KB} KB)  ← what every visitor downloads`,
  );
}
console.log(`  total raw    : ${kb(totalRaw)} KB`);
console.log(`  total gzip   : ${kb(totalGz)} KB`);
console.log(`  total brotli : ${kb(totalBr)} KB  (budget ${TOTAL_BUDGET_KB} KB)  ← backstop`);
console.log(
  `  largest chunk: ${kb(maxChunk.br)} KB brotli — ${maxChunk.f}  (budget ${MAX_CHUNK_BUDGET_KB} KB)`,
);
if (reportPath) console.log(`  report       : ${reportPath}`);
console.log("");

const failures = [];
// The framework chunk (`vendor`, named in nuxt.config's chunkFileNames) must stay a
// LEAF. It is cut from the boot graph without capturing dependencies, on the promise
// that nothing in it imports app code; a node_modules module on the boot path that
// reaches for #app or #imports would break that promise, land here, and make this
// chunk and the boot chunk import each other — and a circular pair can evaluate app
// code before the vue bindings it reads exist, which is a ReferenceError on every
// page's first paint. No test runs the built bundle, so this is the only place that
// would see it before a deploy.
const vendor = files.find((f) => /^vendor\./.test(f));
if (!vendor) failures.push("no vendor.*.js chunk — the framework chunk lost its name (see nuxt.config chunkFileNames)");
else {
  const vendorImports = [...readFileSync(join(dir, vendor), "utf8").matchAll(/\b(?:from|import)\s*["']\.\/([^"']+)["']/g)].map((m) => m[1]);
  if (vendorImports.length)
    failures.push(`vendor chunk ${vendor} imports ${vendorImports.join(", ")} — it must be a leaf (see nuxt.config's vendor group)`);
}
// the tripwire can't sit above the ceiling — a re-anchor that crosses it is the
// ceiling being moved without saying so
if (FIRST_LOAD_BUDGET_KB > FIRST_LOAD_CEILING_KB)
  failures.push(`the tripwire (${FIRST_LOAD_BUDGET_KB} KB) is above the ceiling (${FIRST_LOAD_CEILING_KB} KB) — move the ceiling deliberately or lower the tripwire`);
if (firstLoad && firstBrKb > FIRST_LOAD_CEILING_KB)
  failures.push(
    `first load ${kb(firstBr)} KB is over the ${FIRST_LOAD_CEILING_KB} KB CEILING — shave in this PR (a surface that only opens on a click goes Lazy; see the levers in scripts/bundle-budget.mjs), or make the product case and move the ceiling with it`,
  );
else if (firstLoad && firstBrKb > FIRST_LOAD_BUDGET_KB)
  failures.push(
    `first load ${kb(firstBr)} KB tripped the ${FIRST_LOAD_BUDGET_KB} KB tripwire — check the PR's bundle comment for what grew; if it's the feature, re-anchor FIRST_LOAD_BUDGET_KB to current + ~2 (under the ${FIRST_LOAD_CEILING_KB} KB ceiling); if it's an accident, shave it`,
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
  console.error("\n  See scripts/bundle-budget.mjs for what each line is for.");
  process.exit(1);
}
console.log(
  `✓ Within budget — first load ${kb(firstBr)}/${FIRST_LOAD_BUDGET_KB} KB (ceiling ${FIRST_LOAD_CEILING_KB}), total ${kb(totalBr)}/${TOTAL_BUDGET_KB} KB, largest ${kb(maxChunk.br)}/${MAX_CHUNK_BUDGET_KB} KB; ${vendor} is a leaf.`,
);
