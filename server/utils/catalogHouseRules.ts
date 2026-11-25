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
import { asResearchRow } from "../../scripts/graduate";
import { GRADUATED_FILE_NAME } from "../../scripts/research";
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

const errorsOf = (findings: Finding[]) => findings.filter((f) => f.level === "error").map((f) => f.message);

/**
 * What the build would refuse in this row, each in the audit's own words; [] when it
 * would build. `siblings` are the rows it is compared with: the product's other live rows
 * and every verified row the build sees (catalogVerify's comparedRows), because some rules
 * read one product (a filler variant on a one-row product) and some the whole catalog (one
 * spelling per brand and variant token, one category per gear type). A finding the catalog
 * already had is not the new row's; only one the row brings counts. `file` is where
 * the row graduates to: verified-in-app.json, or for a research row its own research file,
 * where the audit reads a quote's metric figures only (researchChecks).
 */
export function houseRuleProblems(row: RuleRow, siblings: RuleRow[], file: string = GRADUATED_FILE_NAME, was?: RuleRow): string[] {
  const before = new Set(errorsOf(runCatalogChecks(siblings.map(asCsvRow))));
  // `was` is the row as it stands, when the write changes one. A finding it already shared
  // with other rows (a variant token spelled two ways across the catalog) is the catalog's,
  // not this write's: correcting the row's weight isn't refused for it. A finding of the row
  // alone (its name repeating its brand) is still its own to put right.
  const shared = was ? new Set(errorsOf(runCatalogChecks([...siblings, was].map(asCsvRow)))) : new Set<string>();
  const alone = new Set(errorsOf(runCatalogChecks([asCsvRow(row)])));
  const found = errorsOf(runCatalogChecks([...siblings, row].map(asCsvRow))).filter((m) => !before.has(m) && !(shared.has(m) && !alone.has(m)));
  // the row as catalog:graduate would write it; one with no citation never graduates, so
  // only the CSV rules hold it
  const research = asResearchRow(row);
  if (research) found.push(...errorsOf(runResearchChecks([{ file, rows: [research] }])));
  return [...new Set(found)].map((m) => m.replace(`${file}: `, ""));
}
