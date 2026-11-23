// verify_catalog_item's work: an admin marks a catalog row verified from the maker's
// published weight or their own scale, applied at once, without a research PR.
//
// The row stays the database's, not the seed's: verified_by is set, and the seed renames
// and retires only rows that are verified with no verifier (seedManaged). If the research
// later names the same product, the seed's upsert takes the row over under the same id.
// The checks are the audit's own, run at write time: a manufacturer weight needs a
// citation URL and a quote that states it, every weight sits in its kind of gear's range
// unless the admin confirms an outlier, and a new product may not duplicate a live row.
// Every verification records what it replaced in catalog_edits.undo, so revert_catalog_edit
// puts the row back as it was (or retires a product the verification added), and the
// corrections path leaves a verified-in-app row's weight alone (proposeCorrection).

import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { catalogEdits, catalogItems, type CatalogEditUndo } from "../db/schema";
import { categoryForGearType, normalizeVariant, normKey, quoteBacksWeight, RANGE_G, seedManaged } from "../../shared/catalogQuality";
import { isCatalogId, MAX_BRAND_LEN, MAX_GEAR_TYPE_LEN, MAX_ITEM_NAME_LEN, MAX_ITEM_NOTE_LEN, MAX_VARIANT_LEN, UNIT_WEIGHT_MAX_MG } from "../../shared/ops";
import { tidyText } from "../../shared/tidyText";
import { itemDisplayName } from "../../shared/weights";
import { catalogBrands, catalogGearTypes, isHttpUrl, revertEdit } from "./catalog";
import { closestCatalogMatch } from "./candidates";
import { isUniqueViolation, type Db } from "./db";

export const VERIFY_SOURCES = ["manufacturer", "measured"] as const;
export const CATEGORIES = Object.keys(RANGE_G);
/** The caps the tool's schema declares (mcp.ts). A quote or a link past its cap is
 *  refused, not cut: a cut quote can lose the figure it was sent for, and a cut link
 *  goes nowhere. Notes are only kept, so they are cut like any other note. */
export const VERIFY_QUOTE_MAX = MAX_ITEM_NOTE_LEN;
export const VERIFY_URL_MAX = 2000;
export const VERIFY_NOTES_MAX = 500;

type CatalogRow = typeof catalogItems.$inferSelect;
export interface Verified {
  row: CatalogRow;
  /** a product the catalog didn't have, added by this call */
  created: boolean;
  /** a retired row of this product, brought back under its old id by this call */
  revived: boolean;
  /** the catalog_edits row this call wrote: what revert_catalog_edit takes to undo it */
  editId: number;
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
  const sourceUrl = typeof args.source_url === "string" && args.source_url.trim() ? args.source_url.trim() : null;
  if (sourceUrl && sourceUrl.length > VERIFY_URL_MAX) return `source_url is at most ${VERIFY_URL_MAX} characters; give the page's own address.`;
  if (sourceUrl && !isHttpUrl(sourceUrl)) return "source_url must be an http or https address.";
  const quote = typeof args.quote === "string" ? args.quote.trim() : "";
  if (quote.length > VERIFY_QUOTE_MAX) return `quote is at most ${VERIFY_QUOTE_MAX} characters; quote only the line that states the weight.`;
  if (source === "manufacturer") {
    if (!sourceUrl) return "A manufacturer weight needs source_url, the maker's page that publishes it.";
    if (!quote) return "A manufacturer weight needs quote, the maker's own line that states the weight.";
    if (!quoteBacksWeight(quote, grams)) return `The quote doesn't state ${grams} g: none of its figures is within 8 g or 5% of it. Check the number, or quote the line that gives this weight.`;
  }
  const notes = text(args.notes, VERIFY_NOTES_MAX);
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
  } else {
    const name = text(args.name, MAX_ITEM_NAME_LEN);
    if (!name) return "Give catalog_id for a row in the catalog, or name (with brand, variant and gear_type) for a product it doesn't have.";
    if (!gearType) return "A new product needs gear_type, what it is (\"Tent\", \"Rain jacket\"), the label a pick fills in.";
    const typedBrand = text(args.brand, MAX_BRAND_LEN);
    const brand = typedBrand ? spelledAs(typedBrand, await catalogBrands(db)) : null;
    const variant = normalizeVariant(text(args.variant, MAX_VARIANT_LEN)) || null;
    // the identity index holds retired rows too, so a retired row of this identity is the
    // product's own row: brought back below, never a second one beside it
    const [same] = await db
      .select()
      .from(catalogItems)
      .where(and(sql`coalesce(${catalogItems.brand}, '') = ${brand ?? ""}`, eq(catalogItems.name, name), sql`coalesce(${catalogItems.variant}, '') = ${variant ?? ""}`))
      .limit(1);
    if (same?.status === "active") return `${itemDisplayName(brand, name, variant)} is already catalog row ${same.id}; pass catalog_id ${same.id} to verify it.`;
    if (same) current = same;
    else {
      const near = await closestCatalogMatch(db, brand, name, variant);
      if (near) {
        return `Catalog row ${near.id}, ${itemDisplayName(near.brand, near.name, near.variant)}, looks like the same product; pass catalog_id ${near.id} to verify it, or give the size or version that tells them apart.`;
      }
      fresh = { brand, name, variant };
    }
  }

  // A retired row: one merged into a successor is verified there; one removed outright
  // comes back under its old id, as the seed's upsert brings back a row the research names
  // again, so the lists that kept holding that id pick it up. A live research row is the
  // research's to change.
  let revive = false;
  if (current && current.status !== "active") {
    if (current.mergedIntoId) return `Row ${current.id} was retired into row ${current.mergedIntoId}; verify that one.`;
    revive = true;
  } else if (current && seedManaged(current)) {
    return `Row ${current.id} comes from Mahonia's research files and is already verified; a change to it belongs in seed/_research.`;
  }

  // ---- the range, by the row's kind of gear ----
  // the category given, else the one a given gear type names, else the row's own
  const typedKind = category ?? categoryForGearType(gearType);
  const kind = typedKind ?? current?.categoryHint ?? "other";
  const [lo, hi] = RANGE_G[kind] ?? RANGE_G.other!;
  if ((grams < lo || grams > hi) && args.outside_range_ok !== true) {
    return `${grams} g is outside ${lo}–${hi} g, the usual range for ${kind}. Check the number or the category; if the person confirms it, send outside_range_ok: true.`;
  }

  // the gear type given, or the row's own: either joins the suggestions once verified
  const typedLabel = gearType || current?.commonName?.trim() || "";
  const label = typedLabel ? spelledAs(typedLabel, await catalogGearTypes(db)) : null;
  const verified = { weightMg, weightSource: source as string, sourceUrl, sourceQuote: quote || null, verified: true, verifiedBy: userId, updatedAt: new Date() };

  // The edit history and the row are written in ONE statement (the edit as a data-modifying
  // CTE), so neither lands without the other: an "applied" edit for a change that never
  // happened would hand revert_catalog_edit a weight to restore that the row never left.
  if (fresh) {
    try {
      const added = db.$with("added").as(
        db
          .insert(catalogItems)
          .values({
            ...fresh,
            categoryHint: kind,
            commonName: label,
            searchTerms: normKey(label) || null,
            status: "active",
            ...verified,
          })
          .returning(),
      );
      const [edit] = await db
        .with(added)
        .insert(catalogEdits)
        .values(editRow(sql`(select ${sql.identifier("id")} from ${sql.identifier("added")})`, weightMg, weightMg, sourceUrl, notes || "Added and verified by an admin", { status: "removed" }))
        .returning({ id: catalogEdits.id, catalogItemId: catalogEdits.catalogItemId });
      const [row] = await db.select().from(catalogItems).where(eq(catalogItems.id, edit!.catalogItemId)).limit(1);
      return { row: row!, created: true, revived: false, editId: edit!.id };
    } catch (e) {
      // the identity index: the same product added a moment ago
      if (!isUniqueViolation(e)) throw e;
      return `${itemDisplayName(fresh.brand, fresh.name, fresh.variant)} was just added to the catalog; search for it and pass its catalog_id.`;
    }
  }

  const row = current!;
  // what the update replaces, kept on the edit: revert_catalog_edit puts all of it back,
  // not the weight alone
  const undo: CatalogEditUndo = {
    weightSource: row.weightSource,
    sourceUrl: row.sourceUrl,
    sourceQuote: row.sourceQuote,
    verified: row.verified,
    verifiedBy: row.verifiedBy,
    commonName: row.commonName,
    searchTerms: row.searchTerms,
    categoryHint: row.categoryHint,
    status: row.status,
    mergedIntoId: row.mergedIntoId,
  };
  const reason = notes || (source === "measured" ? "Verified: weighed by an admin" : "Verified against the maker's published weight");
  const edit = db.$with("edit").as(
    db.insert(catalogEdits).values(editRow(row.id, Number(row.weightMg), weightMg, sourceUrl, reason, undo)).returning({ id: catalogEdits.id }),
  );
  const [written] = await db
    .with(edit)
    .update(catalogItems)
    .set({
      ...verified,
      // a scale weight usually comes with no link: the row keeps the one it had
      sourceUrl: sourceUrl ?? row.sourceUrl,
      ...(typedKind ? { categoryHint: typedKind } : {}),
      ...(label ? { commonName: label, searchTerms: normKey(label) || null } : {}),
      ...(revive ? { status: "active", mergedIntoId: null } : {}),
    })
    .where(eq(catalogItems.id, row.id))
    // the edit's id, read from the CTE the same statement wrote it in
    .returning({ ...getTableColumns(catalogItems), editId: sql<number>`(select ${sql.identifier("id")} from ${sql.identifier("edit")})` });
  const { editId, ...updated } = written!;
  return { row: updated, created: false, revived: revive, editId: Number(editId) };
}

/**
 * revert_catalog_edit's work: undo one applied edit, an admin's verification or a
 * community correction, and answer the row as it now stands, or a sentence saying why not.
 */
export async function undoCatalogEdit(db: Db, editId: unknown): Promise<{ row: CatalogRow } | string> {
  if (!isCatalogId(editId)) return "edit_id is a catalog edit's id, a whole number from verify_catalog_item or catalog_changes.";
  const out = await revertEdit(db, editId);
  if (out.status === "notfound") return `No catalog edit has id ${editId}.`;
  if (out.status !== "applied") return out.reason ?? `Edit ${editId} can't be undone.`;
  // catalog rows are retired, never deleted, so the edit's row is there to read back
  const [row] = await db.select().from(catalogItems).where(eq(catalogItems.id, out.catalogItemId!)).limit(1);
  return { row: row! };
}

/** One line of the catalog's edit history (catalog_edits), applied: where a verification's
 *  date, source and notes are kept, and what revert_catalog_edit reads and undoes. */
function editRow(catalogItemId: number | SQL, oldWeightMg: number, newWeightMg: number, sourceUrl: string | null, reason: string, undo: CatalogEditUndo) {
  return { catalogItemId, oldWeightMg, newWeightMg, sourceUrl, reason, status: "applied", undo };
}
