// Walking the source tree and reading past its comments — what the three repo-wide
// scanners (prose-dashes, designTokens, bodyWeightPrivacy) each did their own way.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root, with a trailing slash, so `path.slice(ROOT.length)` is a repo path. */
export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Every file under `roots` (repo-relative) with one of `exts` (no dot), as absolute
 *  paths. Build output and dependencies are skipped, and so are the tests themselves —
 *  a scanner is about the code that ships. */
export function walkSources(roots: string[], exts: string[]): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".nuxt", ".output", "dist"]);
  const want = new RegExp(`\\.(${exts.join("|")})$`);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (want.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
  };
  for (const root of roots) walk(join(ROOT, root));
  return out;
}

/** Read a source file. */
export const readSource = (path: string) => readFileSync(path, "utf8");

/** Blank a span rather than delete it, so line numbers in a report stay true. */
export const blank = (m: string) => m.replace(/[^\n]/g, " ");

/** The source with its comments blanked: block comments, HTML comments and `//`
 *  lines — but not the `//` inside "https://" or any other string, where it is text
 *  the scanner should still see. */
export const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
