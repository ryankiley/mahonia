// Research-level gate over seed/_research/*.json — the cited quote must agree with
// the stored weight, a kcal figure must be readable from its own panel quote, and
// a pouch meal must say how it was weighed. These used to run only under
// `npm run catalog:audit`; here they fail `npm test`, and so CI on every PR.

import { describe, expect, it } from "vitest";
import { findingText } from "../scripts/catalogChecks";
import { runResearchChecks } from "../scripts/researchChecks";
import { COMMON_NAMES_JSON, RESEARCH_DIR } from "../scripts/paths";
import { formatResearchFile, loadCommonNames, readResearchFiles, researchFileNames } from "../scripts/research";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const findings = runResearchChecks(readResearchFiles(RESEARCH_DIR), loadCommonNames(COMMON_NAMES_JSON));

describe("seed/_research data quality", () => {
  it("every research file is in the house layout (npm run catalog:format writes it)", () => {
    const off = researchFileNames(RESEARCH_DIR).filter((f) => {
      const raw = readFileSync(join(RESEARCH_DIR, f), "utf8");
      return raw !== formatResearchFile(JSON.parse(raw));
    });
    expect(off).toEqual([]);
  });

  it("has NO error-level defects (quote mismatches, kcal not in its panel, unstated food weight basis, a tent at trail weight, dup identities)", () => {
    expect(findings.filter((f) => f.level === "error").map((f) => `[${f.code}] ${findingText(f)}`)).toEqual([]);
  });
});
