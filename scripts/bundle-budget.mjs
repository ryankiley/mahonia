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

const TOTAL_BUDGET_KB = 125; // all client JS + CSS, brotli
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
