#!/usr/bin/env node
// What a PR costs, in bytes, against main — the paragraph every budget bump used to
// be written by hand, produced by CI instead and posted on the PR whether the gate
// is green or red. That last part is the point: a PR that adds 1.8 KB under the
// tripwire used to say nothing at all, and ten of those were the whole summer.
//
// Usage: node scripts/bundle-delta.mjs <main.json> <pr.json> [--sha=<main sha>]
// Both files come from `bundle-budget.mjs --report=…`. Prints Markdown to stdout;
// never fails — the gate is bundle-budget's job, this is the receipt.

import { readFileSync } from "node:fs";

const [basePath, headPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const sha = (process.argv.find((a) => a.startsWith("--sha=")) ?? "").slice(6);
if (!basePath || !headPath) {
  console.error("usage: bundle-delta.mjs <main.json> <pr.json> [--sha=…]");
  process.exit(2);
}
const base = JSON.parse(readFileSync(basePath, "utf8"));
const head = JSON.parse(readFileSync(headPath, "utf8"));

const kb = (b) => (b / 1024).toFixed(1);
// a signed delta in KB, with a hair of tolerance so a hash reshuffle reads as "—"
const delta = (a, b) => {
  const d = (b - a) / 1024;
  if (Math.abs(d) < 0.05) return "—";
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} KB`;
};
const { ceiling, firstLoad: tripwire, total: totalBudget, maxChunk: maxBudget } = head.budgets;

const lines = [];
const first = head.firstLoad ?? 0;
const room = ceiling * 1024 - first;
lines.push(`### Bundle — first load ${kb(first)} KB (${delta(base.firstLoad ?? 0, first)} vs main)`);
lines.push("");
lines.push("| | main | this PR | Δ |");
lines.push("|---|---:|---:|---:|");
lines.push(`| **First load** — what every visitor to the editor downloads | ${kb(base.firstLoad ?? 0)} KB | **${kb(first)} KB** | **${delta(base.firstLoad ?? 0, first)}** |`);
lines.push(`| ceiling ${ceiling} KB · tripwire ${tripwire} KB | | ${room >= 0 ? `${kb(room)} KB under the ceiling` : `**${kb(-room)} KB OVER the ceiling**`} | |`);
lines.push(`| Total, every chunk (backstop ${totalBudget} KB) | ${kb(base.total)} KB | ${kb(head.total)} KB | ${delta(base.total, head.total)} |`);
lines.push(`| Largest chunk (cap ${maxBudget} KB) | ${kb(base.maxChunk.br)} KB | ${kb(head.maxChunk.br)} KB | ${delta(base.maxChunk.br, head.maxChunk.br)} |`);
lines.push("");

// by source: the union of both sides, sorted by the size of the move
function movers(a, b, threshold = 100) {
  if (!a || !b) return null;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const rows = [...keys]
    .map((k) => ({ k, d: (b[k] ?? 0) - (a[k] ?? 0), was: a[k] ?? 0, now: b[k] ?? 0 }))
    .filter((r) => Math.abs(r.d) >= threshold)
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
  return rows;
}
const moved = movers(base.firstLoadSources, head.firstLoadSources);
if (moved === null) {
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
// and the off-first-load movers, briefly — a lazy chunk growing is fine, but say so
const movedTotal = movers(base.totalSources, head.totalSources, 512);
if (movedTotal && movedTotal.length) {
  const offPath = movedTotal.filter((r) => !moved?.some((m) => m.k === r.k));
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
lines.push(
  `<sub>Brotli, measured by \`scripts/bundle-budget.mjs\` on both builds${sha ? ` (main at ${sha.slice(0, 7)})` : ""}. The ceiling is a product line; the tripwire re-anchors to current + ~2 in the PR that spends it.</sub>`,
);
console.log(lines.join("\n"));
