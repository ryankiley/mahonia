// House style: no em or en dashes in user-facing prose (Ryan, 2026-07-12: "it's an
// AI tell"). The July sweep removed them by hand and they were back within two
// months, because nothing checked. This does: it scans every template text node,
// attribute and string literal in app/, shared/ and server/ — comments and CSS
// stripped — and fails on any dash that isn't one of the deliberate exceptions
// below (title separators, the empty-value cell, numeric ranges, log lines).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["app", "shared", "server"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// Blank a span rather than delete it, so line numbers in the report stay true.
const blank = (m: string) => m.replace(/[^\n]/g, " ");
const stripJs = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // a `//` comment — but not the `//` inside "https://"
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
const stripVue = (s: string) =>
  s
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<script[\s\S]*?<\/script>/g, stripJs)
    .replace(/<!--[\s\S]*?-->/g, blank);

// The dashes that are typography or data, not prose. Each entry names its case.
const ALLOWED: RegExp[] = [
  /— (Mahonia|pack list)["`]/, // "<page> — Mahonia" title separators, the hidden h1
  /Mahonia — pack lists, weighed/, // the site title
  /\$\{m\.title\} — /, // the OG card's "<title> — <weight>" line
  /\$\{name\} — \$\{commonName\}/, // Markdown export: name — gear type
  /join\(" — "\)/, // plain-text export separator
  /[">`']—["<`']/, // a lone "—" as an empty value (cells, placeholders)
  /(\d|\}|\bA)\s*–\s*(\d|\$\{|Z\b)/, // en dash in a range: 1–2, ${a}–${b}, A–Z
  /console\.(error|warn|log)|throw new Error\(|statusMessage:/, // server logs
  /^\s*"\[[a-z-]+\]/, // a log line's tag, on its own line inside a console call
];

describe("user-facing prose", () => {
  it("carries no em or en dashes outside the deliberate exceptions", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(ROOT, root))) {
        const raw = readFileSync(file, "utf8");
        const src = file.endsWith(".vue") ? stripVue(raw) : stripJs(raw);
        src.split("\n").forEach((line, i) => {
          if (!/[—–]/.test(line)) return;
          if (ALLOWED.some((re) => re.test(line))) return;
          offenders.push(`${file.slice(ROOT.length)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
