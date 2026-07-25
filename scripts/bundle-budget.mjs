#!/usr/bin/env node
// Brotli bundle-budget gate. The product shaves grams; the site shaves bytes —
// this fails the build if the client bundle (the JS/CSS a visitor downloads)
// grows past budget once brotli-compressed (what every modern browser actually
// receives, and what Nitro's compressPublicAssets + Vercel's edge serve).
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
// module-scope import in app/pages/changelog.vue, so every entry was bundled into that
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
const TOTAL_BUDGET_KB = 134;
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

const files = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
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
  rows.push({ f, raw: buf.length, br, gz });
}
rows.sort((a, b) => b.br - a.br);

const totalBrKb = totalBr / 1024;
const maxChunk = rows[0] ?? { f: "—", br: 0 };
const maxChunkBrKb = maxChunk.br / 1024;

console.log(`Client bundle (${files.length} files from ${dir}):`);
for (const r of rows.slice(0, 8)) {
  console.log(
    `  ${r.f.padEnd(30)} ${(kb(r.raw) + "KB").padStart(9)} raw → ${(kb(r.br) + "KB").padStart(8)} br`,
  );
}
if (rows.length > 8) console.log(`  …and ${rows.length - 8} more`);
console.log("");
console.log(`  total raw    : ${kb(totalRaw)} KB`);
console.log(`  total gzip   : ${kb(totalGz)} KB`);
console.log(`  total brotli : ${kb(totalBr)} KB  (budget ${TOTAL_BUDGET_KB} KB)`);
console.log(
  `  largest chunk: ${kb(maxChunk.br)} KB brotli — ${maxChunk.f}  (budget ${MAX_CHUNK_BUDGET_KB} KB)`,
);
console.log("");

const failures = [];
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
  `✓ Within budget — ${kb(totalBr)}/${TOTAL_BUDGET_KB} KB brotli, largest ${kb(maxChunk.br)}/${MAX_CHUNK_BUDGET_KB} KB.`,
);
