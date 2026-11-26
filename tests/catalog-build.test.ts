// seed/catalog.csv is generated: `npm run catalog:build` writes it from seed/_research/*.json
// and seed/common-names.json. The seeder and the CSV checks read the committed file, so
// without this test a row added to the CSV by hand passed CI and then vanished at the next
// build (14 rows nearly did in July 2026, PR #112). Here the committed file is held to a fresh
// build, byte for byte, and every research row has to build.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCatalog, catalogCsvText } from "../scripts/catalogBuild";
import { CATALOG_CSV, COMMON_NAMES_JSON, RESEARCH_DIR } from "../scripts/paths";
import { loadCommonNames, readResearchFiles } from "../scripts/research";

const build = buildCatalog(readResearchFiles(RESEARCH_DIR), loadCommonNames(COMMON_NAMES_JSON));

describe("seed/catalog.csv is the research, built", () => {
  it("builds every research row, each with a gear type, and uses every common-names entry", () => {
    expect({
      skipped: build.skipped,
      missingCommon: build.missingCommon.map((r) => [r.brand, r.name, r.variant].filter(Boolean).join(" ")),
      orphaned: build.orphaned,
    }).toEqual({ skipped: [], missingCommon: [], orphaned: [] });
  });

  it("matches a fresh `npm run catalog:build` (run it, and keep only the rows you meant to change)", () => {
    const built = catalogCsvText(build.rows);
    const committed = readFileSync(CATALOG_CSV, "utf8");
    if (built === committed) return;
    // name the rows rather than dumping two four-thousand-line files
    const builtLines = new Set(built.split("\n"));
    const committedLines = new Set(committed.split("\n"));
    expect({
      onlyInTheCommittedCsv: [...committedLines].filter((l) => !builtLines.has(l)),
      onlyInAFreshBuild: [...builtLines].filter((l) => !committedLines.has(l)),
    }).toEqual({ onlyInTheCommittedCsv: [], onlyInAFreshBuild: [] });
    // the same lines in another order, or a line-ending change
    expect(built).toBe(committed);
  });
});
