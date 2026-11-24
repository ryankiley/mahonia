// The pieces of catalog:graduate (scripts/catalog-graduate.ts), apart from its run so a
// test can drive them on PGlite: the in-app verified rows, each as a research row, and
// the merge into the file they graduate to.

import { join } from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import { catalogItems } from "../server/db/schema";
import type { Db } from "../server/utils/db";
import { RESEARCH_DIR } from "./paths";
import { GRADUATED_FILE_NAME, type ResearchRow } from "./research";
import { identity } from "./seedUpsert";

export const GRADUATE_FILE = join(RESEARCH_DIR, GRADUATED_FILE_NAME);

type Row = typeof catalogItems.$inferSelect;

/** One in-app verified row as a research row, or null when it carries no citation URL
 *  (also how verify_catalog_item's house rules read the row it is about to write). */
export function asResearchRow(
  r: Pick<Row, "brand" | "name" | "variant" | "categoryHint" | "commonName" | "weightMg" | "weightSource" | "sourceUrl" | "sourceQuote">,
): ResearchRow | null {
  if (!r.sourceUrl) return null;
  return {
    brand: r.brand,
    name: r.name,
    variant: r.variant,
    category_hint: r.categoryHint,
    common_name: r.commonName,
    weight_value: Number(r.weightMg) / 1000,
    weight_unit: "g",
    weight_source: r.weightSource,
    source_url: r.sourceUrl,
    ...(r.sourceQuote ? { quote: r.sourceQuote } : {}),
  };
}

/** The live rows an admin verified in the app: the ones graduate writes out. */
export async function inAppVerified(db: Db): Promise<Row[]> {
  return db.select().from(catalogItems).where(and(isNotNull(catalogItems.verifiedBy), eq(catalogItems.status, "active")));
}

/** The file's rows with these merged in, a row of the same identity replaced. */
export function mergeResearch(existing: ResearchRow[], incoming: ResearchRow[]): ResearchRow[] {
  const key = (r: ResearchRow) => identity(r.brand ?? null, r.name ?? "", r.variant ?? null);
  const byKey = new Map(existing.map((r) => [key(r), r]));
  for (const r of incoming) byKey.set(key(r), r);
  return [...byKey.values()];
}
