// House style: no em or en dashes in user-facing prose (Ryan, 2026-07-12: "it's an
// AI tell"). The July sweep removed them by hand and they were back within two
// months, because nothing checked. This does: it scans every template text node,
// attribute and string literal in app/, shared/ and server/ — comments and CSS
// stripped — and fails on any dash that isn't one of the deliberate exceptions
// below (title separators, the empty-value cell, numeric ranges, log lines).
//
// The changelog too: content/changelog.d/*.json and the archive are prose a visitor
// reads on /about, and a hundred dashes had gathered there while this test looked
// only at code (swept 2026-09-12).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, blank, stripComments, walkSources } from "./helpers/sources";

const ROOTS = ["app", "shared", "server"];
const CHANGELOG = [
  "content/changelog.json",
  ...readdirSync(join(ROOT, "content/changelog.d"))
    .filter((f) => f.endsWith(".json")) // the folder's README is for us, not the page
    .map((f) => `content/changelog.d/${f}`),
];

// CSS is not prose, a template's comments are not either, and the script block reads
// like any other TypeScript. Spans are blanked, not cut, so line numbers stay true.
const stripVue = (s: string) =>
  s
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<script[\s\S]*?<\/script>/g, stripComments)
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
  /\[[^\]\n]*[–—][^\]\n]*\]/, // a dash READ, not written: inside a regex character class (shared/pasteList)
];

describe("user-facing prose", () => {
  it("carries no em or en dashes outside the deliberate exceptions", () => {
    const offenders: string[] = [];
    const files = [...walkSources(ROOTS, ["vue", "ts"]), ...CHANGELOG.map((f) => join(ROOT, f))];
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      // JSON has no comments to strip: every string in it is a sentence on the page
      const src = file.endsWith(".vue") ? stripVue(raw) : file.endsWith(".json") ? raw : stripComments(raw);
      src.split("\n").forEach((line, i) => {
        if (!/[—–]/.test(line)) return;
        if (ALLOWED.some((re) => re.test(line))) return;
        offenders.push(`${file.slice(ROOT.length)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
