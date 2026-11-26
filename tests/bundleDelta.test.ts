import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The PR receipt (scripts/bundle-delta.mjs), run as CI runs it: two reports in,
// Markdown out. What is pinned here is the one judgement it makes on its own, that a
// first load whose uncompressed bytes did not grow has not been made heavier, whatever
// brotli's figure for it did.

type File = { file: string; br: number; raw?: number; first: boolean };
const report = (files: File[]) => ({
  firstLoad: files.filter((f) => f.first).reduce((n, f) => n + f.br, 0),
  total: files.reduce((n, f) => n + f.br, 0),
  maxChunk: { file: files[0]!.file, br: files[0]!.br },
  budgets: { firstLoad: 175, maxChunk: 72 },
  files,
  firstLoadSources: null,
  totalSources: null,
});

const dir = mkdtempSync(join(tmpdir(), "bundle-delta-"));
let n = 0;
function receipt(base: File[], head: File[]): string {
  const a = join(dir, `base-${++n}.json`);
  const b = join(dir, `head-${n}.json`);
  writeFileSync(a, JSON.stringify(report(base)));
  writeFileSync(b, JSON.stringify(report(head)));
  return execFileSync("node", ["scripts/bundle-delta.mjs", a, b], { encoding: "utf8" });
}

// mahonia#632, as measured: a stylesheet 15 bytes smaller that brotli made 34 larger,
// and a chunk the same size, eight characters different, that it made 69 larger
const main: File[] = [
  { file: "chunk.js", br: 162_628, raw: 510_000, first: true },
  { file: "entry.css", br: 9_250, raw: 53_507, first: true },
  { file: "lazy.js", br: 20_000, raw: 60_000, first: false },
];
const noisy: File[] = [
  { file: "chunk.js", br: 162_697, raw: 510_000, first: true },
  { file: "entry.css", br: 9_284, raw: 53_492, first: true },
  { file: "lazy.js", br: 20_000, raw: 60_000, first: false },
];

describe("the bundle receipt", () => {
  it("calls growth compression noise when the uncompressed first load did not grow", () => {
    const out = receipt(main, noisy);
    expect(out).toContain("(+0.2 KB vs main, compression noise)");
    expect(out).toContain("**Compression noise, not a cost.**");
    expect(out).toContain("is 15 B smaller (563,507 → 563,492 B)");
    expect(out).toContain("The +103 B above");
  });

  it("says nothing of the kind when the first load really grew", () => {
    const heavier = noisy.map((f) => (f.file === "entry.css" ? { ...f, raw: 53_900 } : f));
    const out = receipt(main, heavier);
    expect(out).toContain("(+0.2 KB vs main)");
    expect(out).not.toContain("ompression noise");
  });

  it("claims nothing against a baseline written before reports carried raw sizes", () => {
    const old = main.map(({ raw: _raw, ...f }) => f);
    const out = receipt(old, noisy);
    expect(out).toContain("(+0.2 KB vs main)");
    expect(out).not.toContain("ompression noise");
  });

  it("leaves a wobble that rounds away alone", () => {
    // clear of a rounding boundary on both sides (main's own figure sits on one, which
    // is half of how 103 bytes came to read as 0.2 KB)
    const settled = main.map((f) => (f.file === "chunk.js" ? { ...f, br: 162_700 } : f));
    const wobble = settled.map((f) => (f.file === "chunk.js" ? { ...f, br: f.br + 20 } : f));
    const out = receipt(settled, wobble);
    expect(out).toContain("(— vs main)");
    expect(out).not.toContain("ompression noise");
  });
});
