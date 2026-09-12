#!/usr/bin/env node
// What a PR costs, in bytes, against main — the paragraph every budget bump used to
// be written by hand, produced by CI instead and posted on the PR whether the gate
// is green or red. That last part is the point: a PR that adds 1.8 KB under the
// tripwire used to say nothing at all, and ten of those were the whole summer.
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
const measured = (v) => typeof v === "number";
const { ceiling, firstLoad: tripwire, total: totalBudget, maxChunk: maxBudget } = head.budgets;

const lines = [];
// "not measured" is not zero: a build whose /e prerender is missing has no first
// load to report, and rendering it as 0.0 KB would celebrate a 146 KB saving
const first = head.firstLoad;
const firstBase = base.firstLoad;
const bothFirst = measured(first) && measured(firstBase);
const firstCell = (v) => (measured(v) ? `${kb(v)} KB` : "not measured");
if (measured(first)) {
  lines.push(`### Bundle — first load ${kb(first)} KB (${bothFirst ? delta(firstBase, first) : "main not measured"} vs main)`);
} else {
  lines.push("### Bundle — first load not measured (`/e/index.html` is not in this build)");
}
lines.push("");
lines.push("| | main | this PR | Δ |");
lines.push("|---|---:|---:|---:|");
lines.push(`| **First load** — what every visitor to the editor downloads | ${firstCell(firstBase)} | **${firstCell(first)}** | **${bothFirst ? delta(firstBase, first) : "—"}** |`);
const room = measured(first) ? ceiling * 1024 - first : null;
lines.push(
  `| ceiling ${ceiling} KB · tripwire ${tripwire} KB | | ${
    room === null ? "—" : room >= 0 ? `${kb(room)} KB under the ceiling` : `**${kb(-room)} KB OVER the ceiling**`
  } | |`,
);
lines.push(`| Total, every chunk (backstop ${totalBudget} KB) | ${kb(base.total)} KB | ${kb(head.total)} KB | ${delta(base.total, head.total)} |`);
lines.push(`| Largest chunk (cap ${maxBudget} KB) | ${kb(base.maxChunk.br)} KB | ${kb(head.maxChunk.br)} KB | ${delta(base.maxChunk.br, head.maxChunk.br)} |`);
lines.push("");

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
const moved = bothFirst ? movers(base.firstLoadSources, head.firstLoadSources, 100) : null;
if (!attributed) {
  lines.push("_No per-source attribution: one of the builds ran without hidden sourcemaps (BUNDLE_MAPS=1)._");
} else if (!bothFirst) {
  lines.push("_No first-load attribution: the first load was not measured on one side._");
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
    Object.fromEntries(Object.entries(rep.totalSources).map(([k, v]) => [k, v - (rep.firstLoadSources?.[k] ?? 0)]));
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
  }${sha ? ")" : ""}. The ceiling is a product line; the tripwire re-anchors to current + ~2 in the PR that spends it.</sub>`,
);
console.log(lines.join("\n"));
