// Data-quality gate over the committed seed/catalog.csv. This is the safety net
// that turns "things we kept hand-cleaning" into a failing test: if a row ships
// with research commentary in its variant, a same-product duplicate, or a
// case-only identity collision, `npm test` fails here instead of someone
// noticing it three turns later.

import { readFileSync } from "node:fs";
import { EXTRA_TERMS, isVocabularyCanon } from "../scripts/searchTerms";
import { describe, expect, it } from "vitest";
import { csvToCatalogRows, isCitationUrl, isWeightSource } from "../scripts/catalogCsv";
import { runCatalogChecks } from "../scripts/catalogChecks";
import { CATALOG_CSV } from "../scripts/paths";
import { GEAR_TRAITS } from "../shared/catalogAxes";
import { isProductSlug } from "../shared/catalogSlug";

const rows = csvToCatalogRows(readFileSync(CATALOG_CSV, "utf8"));
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

  // A traits entry keyed by a gear type no row carries is dead: the variant reader or a
  // check quietly stops firing for that type (a rename through the drift map, a typo), and
  // fewer findings look like success. Same guard the build puts on common-names.json.
  it("every EXTRA_TERMS canon in scripts/searchTerms.ts is a noun or a live gear type", () => {
    // A search-only word list hangs off a noun or off a gear type spelled exactly as the
    // catalog spells it (lowercased). A key that is neither matches no row and is dead
    // vocabulary — a misspelt type would sit there silently.
    const liveTypes = new Set(rows.map((r) => (r.commonName ?? "").trim().toLowerCase()));
    const dead = Object.keys(EXTRA_TERMS).filter((k) => !isVocabularyCanon(k) && !liveTypes.has(k));
    expect(dead).toEqual([]);
  });

  it("every gear type in shared/catalogAxes.ts is a live catalog type", () => {
    const live = new Set(rows.map((r) => (r.commonName ?? "").toLowerCase()));
    expect(Object.keys(GEAR_TRAITS).filter((t) => !live.has(t))).toEqual([]);
  });

  it("every row has provenance, a citation URL and the cited words", () => {
    const bad = rows.filter(
      (r) => !isWeightSource(r.weightSource) || !isCitationUrl(r.sourceUrl ?? "") || !(r.quote ?? "").trim(),
    );
    expect(bad.map((r) => r.name)).toEqual([]);
  });

  it("every product has one address and no two products share it", () => {
    // the slug is what /catalog/<brand>/<product> resolves and what the seeder stores;
    // the build's slug-collision rule is the gate, this is the count behind it
    const products = new Set(rows.map((r) => `${(r.brand ?? "").toLowerCase()}|${r.name.toLowerCase()}`));
    const slugs = new Set(rows.map((r) => r.slug));
    expect(slugs.size).toBe(products.size);
    expect(rows.every((r) => isProductSlug(r.slug))).toBe(true);
  });
});
