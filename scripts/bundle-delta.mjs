#!/usr/bin/env node
// What a PR costs, in bytes, against main — the paragraph every budget bump used to
// be written by hand, produced by CI instead and posted on the PR whether the gate
// is green or red. That last part is the point: a PR that adds 1.8 KB under the
// cap says nothing at the gate, and ten of those were a whole summer.
//
// Usage: node scripts/bundle-delta.mjs <main.json> <pr.json> [--sha=<baseline sha>] [--base=<the PR's base sha>]
// Both files come from `bundle-budget.mjs --report=…` (scripts/bundleReport.mjs is
// the shape). Prints Markdown to stdout. It throws on a report it can't read — the
// CI step that runs it is allowed to fail without failing the job, and a failure
// leaves the PR's previous receipt in place rather than posting a blank one.

import { kb, loadReport } from "./bundleReport.mjs";

const [basePath, headPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? "").slice(name.length + 3);
const sha = flag("sha");
const baseSha = flag("base");
if (!basePath || !headPath) {
  console.error("usage: bundle-delta.mjs <main.json> <pr.json> [--sha=…] [--base=…]");
  process.exit(2);
}
const base = loadReport(basePath);
const head = loadReport(headPath);

// A signed delta in KB, derived from the two ROUNDED figures so the three cells of
// a row can't disagree (52.7 | 52.8 | — was possible when the delta rounded on its
// own); a hash reshuffle that moves nothing at one decimal reads as "—".
const delta = (a, b) => {
  const d = Math.round(b / 102.4) - Math.round(a / 102.4);
  if (d === 0) return "—";
  return `${d > 0 ? "+" : "−"}${(Math.abs(d) / 10).toFixed(1)} KB`;
};
const { firstLoad: cap, maxChunk: maxBudget } = head.budgets;

// THE COMPRESSOR'S OWN NOISE. Brotli at quality 11 is not monotonic: a stylesheet that
// lost a declaration came out 34 B larger, and a chunk whose only change was the eight
// characters of that stylesheet's new hash in its import list came out 69 B larger, with
// its uncompressed size and its gzip both unchanged. Together 104 B, which the rounding
// below showed as "+0.2 KB" on a PR that ships 15 fewer bytes (#632). The uncompressed
// size is the figure brotli can't move, so when the first load's did not grow, whatever
// its brotli figure gained is the compressor placing its blocks differently and the
// receipt says so, in bytes, where it would otherwise send someone looking for a cost.
// Null when either report predates `raw` (bundle-budget.mjs): then nothing is claimed.
const rawFirstLoad = (rep) => {
  const first = rep.files.filter((f) => f.first);
  return first.length && first.every((f) => typeof f.raw === "number") ? first.reduce((n, f) => n + f.raw, 0) : null;
};
const signedBytes = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("en-US")} B`;

const lines = [];
const first = head.firstLoad;
const firstBase = base.firstLoad;
const rawWas = rawFirstLoad(base);
const rawNow = rawFirstLoad(head);
// only where the table shows growth: a wobble that rounds to "—" needs no explaining
const noise = rawWas !== null && rawNow !== null && rawNow <= rawWas && first > firstBase && delta(firstBase, first) !== "—";
lines.push(`### Bundle — first load ${kb(first)} KB (${delta(firstBase, first)} vs main${noise ? ", compression noise" : ""})`);
lines.push("");
lines.push("| | main | this PR | Δ |");
lines.push("|---|---:|---:|---:|");
lines.push(`| **First load** — what every visitor to the editor downloads | ${kb(firstBase)} KB | **${kb(first)} KB** | **${delta(firstBase, first)}** |`);
const room = cap * 1024 - first;
lines.push(`| cap ${cap} KB | | ${room >= 0 ? `${kb(room)} KB under the cap` : `**${kb(-room)} KB OVER the cap**`} | |`);
lines.push(`| Total, every chunk | ${kb(base.total)} KB | ${kb(head.total)} KB | ${delta(base.total, head.total)} |`);
lines.push(`| Largest chunk (cap ${maxBudget} KB) | ${kb(base.maxChunk.br)} KB | ${kb(head.maxChunk.br)} KB | ${delta(base.maxChunk.br, head.maxChunk.br)} |`);
lines.push("");
if (noise) {
  const rawMove = rawNow - rawWas;
  lines.push(
    `**Compression noise, not a cost.** Uncompressed, the first load ${
      rawMove === 0 ? "is the same size" : `is ${signedBytes(-rawMove).replace("+", "")} smaller`
    } (${rawWas.toLocaleString("en-US")} → ${rawNow.toLocaleString("en-US")} B). The ${signedBytes(first - firstBase)} above is brotli packing nearly the same bytes differently; there is nothing in this PR to shave.`,
  );
  lines.push("");
}

// by source: the union of both sides, sorted by the size of the move
function movers(a, b, threshold) {
  if (!a || !b) return null;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys]
    .map((k) => ({ k, d: (b[k] ?? 0) - (a[k] ?? 0), was: a[k] ?? 0, now: b[k] ?? 0 }))
    .filter((r) => Math.abs(r.d) >= threshold)
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
}
const attributed = base.totalSources && head.totalSources;
const moved = attributed ? movers(base.firstLoadSources, head.firstLoadSources, 100) : null;
if (!attributed) {
  lines.push("_No per-source attribution: one of the builds ran without hidden sourcemaps (BUNDLE_MAPS=1)._");
} else if (moved.length === 0) {
  lines.push("Nothing on the first load moved by 0.1 KB or more.");
} else {
  lines.push("**Where the first load moved** (brotli, by source, ≥ 0.1 KB):");
  lines.push("");
  lines.push("| Δ | source | main → PR |");
  lines.push("|---:|---|---:|");
  for (const r of moved.slice(0, 12)) {
    const tag = r.was === 0 ? " · new to the first load" : r.now === 0 ? " · off the first load" : "";
    lines.push(`| ${delta(r.was, r.now)} | \`${r.k}\`${tag} | ${kb(r.was)} → ${kb(r.now)} |`);
  }
  if (moved.length > 12) lines.push(`| | _…and ${moved.length - 12} more_ | |`);
  lines.push("");
}
// …and off it: each source's bytes OUTSIDE the first load, subtracted per side, so a
// source that moved on both — a package with glyphs on the hot path and glyphs in a
// lazy menu — shows its off-path move with its own sign. (Filtering the total movers
// by "not in the table above" dropped exactly those, and would have printed the
// total delta, sometimes the opposite sign, for the ones it kept.)
if (attributed) {
  const off = (rep) =>
    Object.fromEntries(Object.entries(rep.totalSources).map(([k, v]) => [k, v - (rep.firstLoadSources[k] ?? 0)]));
  const offPath = movers(off(base), off(head), 512);
  if (offPath.length) {
    lines.push(
      `Off the first load (lazy chunks, other routes), ≥ 0.5 KB: ${offPath
        .slice(0, 6)
        .map((r) => `\`${r.k}\` ${delta(r.was, r.now)}`)
        .join(" · ")}`,
    );
    lines.push("");
  }
}
const stale = sha && baseSha && sha !== baseSha;
lines.push(
  `<sub>Brotli, measured by \`scripts/bundle-budget.mjs\` on both builds${sha ? ` (main at ${sha.slice(0, 7)}` : ""}${
    stale ? `; this PR's merge was built on ${baseSha.slice(0, 7)} — main moved since this baseline, so some of the delta may be another PR's` : ""
  }${sha ? ")" : ""}. The cap is a product line; this comment is the record of what a PR costs.</sub>`,
);
console.log(lines.join("\n"));
