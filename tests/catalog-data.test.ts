// Data-quality gate over the committed seed/catalog.csv. This is the safety net
// that turns "things we kept hand-cleaning" into a failing test: if a row ships
// with research commentary in its variant, a same-product duplicate, or a
// case-only identity collision, `npm test` fails here instead of someone
// noticing it three turns later.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { csvToCatalogRows } from "../scripts/catalogCsv";
import { runCatalogChecks } from "../scripts/catalogChecks";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rows = csvToCatalogRows(readFileSync(join(root, "seed/catalog.csv"), "utf8"));
const findings = runCatalogChecks(rows);
const errors = findings.filter((f) => f.level === "error");

describe("seed/catalog.csv data quality", () => {
  it("has a sensible number of rows", () => {
    expect(rows.length).toBeGreaterThan(300);
  });

  it("has NO error-level defects (commentary variants, dup rows, case collisions)", () => {
    // Surface the actual messages on failure so the fix is obvious.
    expect(errors.map((e) => `[${e.code}] ${e.message}`)).toEqual([]);
  });

  // ("every row has a gear type" and "no un-normalized drift terms" used to live here as
  //  their own it() blocks. They're standing defect classes, so they now run inside
  //  runCatalogChecks — gated by the error assertion above AND reported by
  //  `npm run catalog:audit`, which the bespoke versions were invisible to.)

  it("every row has provenance + a citation URL", () => {
    const bad = rows.filter(
      (r) =>
        !["manufacturer", "measured", "community", "imported"].includes(r.weightSource) ||
        !/^https?:\/\/.+/i.test(r.sourceUrl ?? ""),
    );
    expect(bad.map((r) => r.name)).toEqual([]);
  });
});
