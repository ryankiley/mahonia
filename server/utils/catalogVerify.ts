// verify_catalog_item's work: an admin marks a catalog row verified from the maker's
// published weight or their own scale, applied at once, without a research PR.
//
// The row stays the database's, not the seed's: verified_by is set, and the seed renames
// and retires only rows that are verified with no verifier (seedManaged). If the research
// later names the same product, the seed's upsert takes the row over under the same id.
// The checks are the audit's own, run at write time: a manufacturer weight needs a
// citation URL and a quote that states it, every weight sits in its kind of gear's range
// unless the admin confirms an outlier, and a new product may not duplicate a live row.

import { and, eq, sql } from "drizzle-orm";
import { catalogEdits, catalogItems } from "../db/schema";
import { categoryForGearType, normalizeVariant, normKey, quoteBacksWeight, RANGE_G, seedManaged } from "../../shared/catalogQuality";
import { isCatalogId, MAX_BRAND_LEN, MAX_GEAR_TYPE_LEN, MAX_ITEM_NAME_LEN, MAX_ITEM_NOTE_LEN, MAX_VARIANT_LEN, UNIT_WEIGHT_MAX_MG } from "../../shared/ops";
import { tidyText } from "../../shared/tidyText";
import { itemDisplayName } from "../../shared/weights";
import { catalogBrands, catalogGearTypes, isHttpUrl } from "./catalog";
import { closestCatalogMatch } from "./candidates";
import { isUniqueViolation, type Db } from "./db";

export const VERIFY_SOURCES = ["manufacturer", "measured"] as const;
export const CATEGORIES = Object.keys(RANGE_G);

type CatalogRow = typeof catalogItems.$inferSelect;
export interface Verified {
  row: CatalogRow;
  /** a product the catalog didn't have, added by this call */
  created: boolean;
}

/** A one-line text argument, tidied and capped; "" when absent or not a string. */
const text = (v: unknown, max: number) => (typeof v === "string" ? tidyText(v).slice(0, max) : "");

/** The vocabulary's own spelling of a label, matched without case ("tent" → "Tent",
 *  "sea to summit" → "Sea to Summit"), else the label with its first letter raised. A
 *  verified row joins the brand and gear-type suggestions (catalogBrands,
 *  catalogGearTypes), so it shouldn't bring a second spelling of one in. */
function spelledAs(label: string, vocabulary: string[]): string {
  const found = vocabulary.find((v) => v.toLowerCase() === label.toLowerCase());
  return found ?? label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Verify a catalog row, or add a product the catalog doesn't have as a verified row.
 * Answers the row, or a sentence saying what to change, for the model to read.
 */
export async function verifyCatalogItem(db: Db, userId: number, args: Record<string, unknown>): Promise<Verified | string> {
  // ---- the weight and its evidence ----
  const grams = typeof args.weight_g === "number" ? args.weight_g : NaN;
  const weightMg = Math.round(grams * 1000);
  if (!Number.isFinite(grams) || weightMg <= 0 || weightMg > UNIT_WEIGHT_MAX_MG) {
    return `weight_g is the weight of one unit in grams, above 0 and up to ${UNIT_WEIGHT_MAX_MG / 1e6} kg.`;
  }
  const source = args.weight_source ?? "manufacturer";
  if (!VERIFY_SOURCES.includes(source as (typeof VERIFY_SOURCES)[number])) return `weight_source is manufacturer (the maker's published weight) or measured (weighed on the person's own scale).`;
  const sourceUrl = typeof args.source_url === "string" && args.source_url.trim() ? args.source_url.trim().slice(0, 2000) : null;
  if (sourceUrl && !isHttpUrl(sourceUrl)) return "source_url must be an http or https address.";
  const quote = typeof args.quote === "string" ? args.quote.trim().slice(0, MAX_ITEM_NOTE_LEN) : "";
  if (source === "manufacturer") {
    if (!sourceUrl) return "A manufacturer weight needs source_url, the maker's page that publishes it.";
    if (!quote) return "A manufacturer weight needs quote, the maker's own line that states the weight.";
    if (!quoteBacksWeight(quote, grams)) return `The quote doesn't state ${grams} g: none of its figures is within 8 g or 5% of it. Check the number, or quote the line that gives this weight.`;
  }
  const notes = text(args.notes, 500);
  const gearType = text(args.gear_type, MAX_GEAR_TYPE_LEN);
  const category = args.category == null ? null : String(args.category).trim().toLowerCase();
  if (category != null && !CATEGORIES.includes(category)) return `category is one of ${CATEGORIES.join(", ")}.`;

  // ---- the row: one that exists, or a new product ----
  let current: CatalogRow | undefined;
  let fresh: { brand: string | null; name: string; variant: string | null } | undefined;
  if (args.catalog_id != null) {
    if (!isCatalogId(args.catalog_id)) return "catalog_id is a catalog row's id, a whole number from search_catalog.";
    [current] = await db.select().from(catalogItems).where(eq(catalogItems.id, args.catalog_id)).limit(1);
    if (!current) return `No catalog row has id ${args.catalog_id}.`;
    if (current.status !== "active") {
      return current.mergedIntoId ? `Row ${current.id} was retired into row ${current.mergedIntoId}; verify that one.` : `Row ${current.id} was retired from the catalog.`;
    }
    if (seedManaged(current)) return `Row ${current.id} comes from Mahonia's research files and is already verified; a change to it belongs in seed/_research.`;
  } else {
    const name = text(args.name, MAX_ITEM_NAME_LEN);
    if (!name) return "Give catalog_id for a row in the catalog, or name (with brand, variant and gear_type) for a product it doesn't have.";
    if (!gearType) return "A new product needs gear_type, what it is (\"Tent\", \"Rain jacket\"), the label a pick fills in.";
    const typedBrand = text(args.brand, MAX_BRAND_LEN);
    const brand = typedBrand ? spelledAs(typedBrand, await catalogBrands(db)) : null;
    const variant = normalizeVariant(text(args.variant, MAX_VARIANT_LEN)) || null;
    const [same] = await db
      .select({ id: catalogItems.id })
      .from(catalogItems)
      .where(and(sql`coalesce(${catalogItems.brand}, '') = ${brand ?? ""}`, eq(catalogItems.name, name), sql`coalesce(${catalogItems.variant}, '') = ${variant ?? ""}`))
      .limit(1);
    if (same) return `${itemDisplayName(brand, name, variant)} is already catalog row ${same.id}; pass catalog_id ${same.id} to verify it.`;
    const near = await closestCatalogMatch(db, brand, name, variant);
    if (near) {
      return `Catalog row ${near.id}, ${itemDisplayName(near.brand, near.name, near.variant)}, looks like the same product; pass catalog_id ${near.id} to verify it, or give the size or version that tells them apart.`;
    }
    fresh = { brand, name, variant };
  }

  // ---- the range, by the row's kind of gear ----
  const kind = category ?? (fresh ? categoryForGearType(gearType) : current?.categoryHint) ?? "other";
  const [lo, hi] = RANGE_G[kind] ?? RANGE_G.other!;
  if ((grams < lo || grams > hi) && args.outside_range_ok !== true) {
    return `${grams} g is outside ${lo}–${hi} g, the usual range for ${kind}. Check the number or the category; if the person confirms it, send outside_range_ok: true.`;
  }

  // the gear type given, or the row's own: either joins the suggestions once verified
  const typedLabel = gearType || current?.commonName?.trim() || "";
  const label = typedLabel ? spelledAs(typedLabel, await catalogGearTypes(db)) : null;
  const verified = { weightMg, weightSource: source as string, sourceUrl, sourceQuote: quote || null, verified: true, verifiedBy: userId, updatedAt: new Date() };

  if (fresh) {
    try {
      const [row] = await db
        .insert(catalogItems)
        .values({
          ...fresh,
          categoryHint: kind,
          commonName: label,
          searchTerms: normKey(label) || null,
          status: "active",
          ...verified,
        })
        .returning();
      await recordEdit(db, row!.id, weightMg, weightMg, sourceUrl, notes || "Added and verified by an admin");
      return { row: row!, created: true };
    } catch (e) {
      // the identity index: the same product added a moment ago
      if (!isUniqueViolation(e)) throw e;
      return `${itemDisplayName(fresh.brand, fresh.name, fresh.variant)} was just added to the catalog; search for it and pass its catalog_id.`;
    }
  }

  const row = current!;
  // the edit history first, as a correction writes it: the change stays revertible
  await recordEdit(db, row.id, Number(row.weightMg), weightMg, sourceUrl, notes || (source === "measured" ? "Verified: weighed by an admin" : "Verified against the maker's published weight"));
  const [updated] = await db
    .update(catalogItems)
    .set({
      ...verified,
      ...(category ? { categoryHint: category } : {}),
      ...(label ? { commonName: label, searchTerms: normKey(label) || null } : {}),
    })
    .where(eq(catalogItems.id, row.id))
    .returning();
  return { row: updated!, created: false };
}

/** One line of the catalog's edit history (catalog_edits), applied: where a verification's
 *  date, source and notes are kept, and what the admin revert reads. */
async function recordEdit(db: Db, catalogItemId: number, oldWeightMg: number, newWeightMg: number, sourceUrl: string | null, reason: string): Promise<void> {
  await db.insert(catalogEdits).values({ catalogItemId, oldWeightMg, newWeightMg, sourceUrl, reason, status: "applied" });
}
