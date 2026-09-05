// Research-level gate over seed/_research/*.json — the cited quote must agree with
// the stored weight, a kcal figure must be readable from its own panel quote, and
// a pouch meal must say how it was weighed. These used to run only under
// `npm run catalog:audit`; here they fail `npm test`, and so CI on every PR.

import { describe, expect, it } from "vitest";
import { runResearchChecks } from "../scripts/researchChecks";
import { RESEARCH_DIR } from "../scripts/paths";
import { readResearchFiles } from "../scripts/research";

const findings = runResearchChecks(readResearchFiles(RESEARCH_DIR));

describe("seed/_research data quality", () => {
  it("has NO error-level defects (quote mismatches, kcal not in its panel, unstated food weight basis, dup identities)", () => {
    expect(findings.filter((f) => f.level === "error").map((f) => `[${f.code}] ${f.message}`)).toEqual([]);
  });
});
