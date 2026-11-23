// The catalog audit's own rules, run on the one row verify_catalog_item is about to write.
//
// The research rows meet the house style because `npm test` fails a PR that breaks it
// (scripts/catalogChecks.ts over the built CSV, scripts/researchChecks.ts over the cited
// rows). A row written from a chat skips that gate, so the same two checkers run here on
// the row as it would graduate (scripts/graduate.ts) and refuse what the build would: a
// colour in the variant, a name that repeats its brand, a shoe size with two regions or
// none, size letters, filler variants, a manufacturer weight cited to a review site, a
// tent stored at trail weight. Nothing is restated, so the build and the tool can't drift.

import { extractAttributes } from "../../scripts/catalogAttributes";
import { runCatalogChecks, type Finding } from "../../scripts/catalogChecks";
import type { CatalogCsvRow } from "../../scripts/catalogCsv";
import { GRADUATED_FILE_NAME, type ResearchRow } from "../../scripts/research";
import { runResearchChecks } from "../../scripts/researchChecks";

/** A catalog row in the fields the checks read. */
export interface RuleRow {
  brand: string | null;
  name: string;
  variant: string | null;
  commonName: string | null;
  categoryHint: string | null;
  weightMg: number;
  weightSource: string;
  sourceUrl: string | null;
  sourceQuote: string | null;
}

/** The row as the build would write it into the CSV: its axes read out of the variant. */
function asCsvRow(r: RuleRow): CatalogCsvRow {
  const attributes = extractAttributes(r.variant, r.commonName, r.categoryHint);
  return {
    brand: r.brand,
    name: r.name,
    commonName: r.commonName,
    variant: r.variant,
    attributes: Object.keys(attributes).length ? attributes : null,
    attributesUnpublished: [],
    categoryHint: r.categoryHint,
    weightMg: r.weightMg,
    kcal: null,
    weightSource: r.weightSource,
    sourceUrl: r.sourceUrl,
    searchTerms: null,
  };
}

/** The row as catalog:graduate would write it into seed/_research (asResearchRow). */
const asResearchRow = (r: RuleRow): ResearchRow => ({
  brand: r.brand,
  name: r.name,
  variant: r.variant,
  category_hint: r.categoryHint,
  common_name: r.commonName,
  weight_value: r.weightMg / 1000,
  weight_unit: "g",
  weight_source: r.weightSource,
  source_url: r.sourceUrl ?? "",
  ...(r.sourceQuote ? { quote: r.sourceQuote } : {}),
});

const errorsOf = (findings: Finding[]) => findings.filter((f) => f.level === "error").map((f) => f.message);

/**
 * What the build would refuse in this row, each in the audit's own words; [] when it
 * would build. `siblings` are the product's other live rows (same brand and name): the
 * rules that compare rows (a filler variant on a one-row product, one variant spelled
 * two ways) read them, and only a finding the new row brings is its own.
 */
export function houseRuleProblems(row: RuleRow, siblings: RuleRow[]): string[] {
  const before = new Set(errorsOf(runCatalogChecks(siblings.map(asCsvRow))));
  const found = errorsOf(runCatalogChecks([...siblings, row].map(asCsvRow))).filter((m) => !before.has(m));
  // a row with no citation never graduates (graduate skips it), so only the CSV rules hold it
  if (row.sourceUrl) found.push(...errorsOf(runResearchChecks([{ file: GRADUATED_FILE_NAME, rows: [asResearchRow(row)] }])));
  return [...new Set(found)].map((m) => m.replace(`${GRADUATED_FILE_NAME}: `, ""));
}
