// verify_catalog_item's work: an admin marks a catalog row verified from the maker's
// published weight or their own scale, applied at once, without a research PR.
//
// The row stays the database's, not the seed's: verified_by is set, and the seed renames
// and retires only rows that are verified with no verifier (seedManaged). If the research
// later names the same product, the seed's upsert takes the row over under the same id,
// once the research agrees with it on the weight and its citation; until then the reseed
// leaves it be (upsertSeedRows), and catalog:graduate writes it back into the research.
//
// A row from the research files (seedManaged, or one that was before an earlier call here)
// takes a new maker's weight with its page and quote, so a maker's re-specced figure needs
// no research PR. Nothing else about it is the tool's to change: a new name or gear type
// would leave the research naming the old one, which the next reseed would add again
// beside it, and a scale weight is the person's own piece's, not the maker's figure.
//
// A chat writes these rows, so the tool carries the rules a person would otherwise have to
// repeat to every chat, and refuses in a sentence the model can act on:
//   • the evidence: a manufacturer weight needs a citation URL and a quote that states it
//     (a fabric's g/m² or a stove's g/hr is not a weight; catalogQuality's quote reader);
//   • the house style: the catalog audit's own rules, run on the row as it would graduate
//     (catalogHouseRules), so a row written here is one the build accepts;
//   • the number: a weight outside its kind of gear's range, or far from what an existing
//     row weighs (the wrong row picked, a slip of the decimal), waits for the person to
//     confirm it (weight_confirmed). Both are named in ONE refusal, so the person's
//     confirmation covers what they were told and nothing they weren't;
//   • duplicates: a new product may not repeat a live row (every near match is named, and
//     distinct_from lists the ones the person checked are other products), and the same
//     call sent twice (a retry) writes nothing the second time;
//   • volume: a runaway loop stops at VERIFY_HOURLY_MAX verifications an hour.
// Every verification records what it replaced in catalog_edits.undo, so revert_catalog_edit
// puts the row back as it was (its name too, or retires a product the verification added),
// and the corrections path leaves a verified-in-app row's weight alone (proposeCorrection).
// So what the person should hear, but what one call undoes, is written and named in the
// answer's warnings rather than refused: a scale weight that replaced the maker's published
// one, and a scale weight of gear sold by size that names no size.

import { and, desc, eq, getTableColumns, gt, isNotNull, sql, type SQL } from "drizzle-orm";
import { catalogEdits, catalogItems, type CatalogEditUndo } from "../db/schema";
import { normalizeGearType } from "../../scripts/gearTypes";
import { soldByOf } from "../../shared/catalogAxes";
import { categoryForGearType, normalizeVariant, normKey, quoteBacksWeight, RANGE_G, seedManaged, tidyQuote } from "../../shared/catalogQuality";
import { isCatalogId, MAX_BRAND_LEN, MAX_GEAR_TYPE_LEN, MAX_ITEM_NAME_LEN, MAX_ITEM_NOTE_LEN, MAX_VARIANT_LEN, UNIT_WEIGHT_MAX_MG } from "../../shared/ops";
import { foldApostrophes, tidyText } from "../../shared/tidyText";
import { itemDisplayName } from "../../shared/weights";
import { catalogBrands, catalogGearTypes, isHttpUrl } from "./catalog";
import { houseRuleProblems, type RuleRow } from "./catalogHouseRules";
import { catalogMatches } from "./candidates";
import { namesSize } from "./catalogSizes";
import { isUniqueViolation, type Db } from "./db";

export const VERIFY_SOURCES = ["manufacturer", "measured"] as const;
export const CATEGORIES = Object.keys(RANGE_G);
/** The caps the tool's schema declares (mcp.ts). A quote or a link past its cap is
 *  refused, not cut: a cut quote can lose the figure it was sent for, and a cut link
 *  goes nowhere. Notes are only kept, so they are cut like any other note. */
export const VERIFY_QUOTE_MAX = MAX_ITEM_NOTE_LEN;
export const VERIFY_URL_MAX = 2000;
export const VERIFY_NOTES_MAX = 500;
/** Verifications across all admins in an hour before the tool stops: a person checking a
 *  shelf of gear stays well under it, a loop that went wrong doesn't get far. */
export const VERIFY_HOURLY_MAX = 60;
/** How far a new weight may sit from what a row weighs now before the person confirms it:
 *  25 g or 30%, whichever is more. Past it, the likelier story is the wrong row, the wrong
 *  size or a slipped decimal than a row that was that far off. */
const bigChange = (fromG: number, toG: number) => Math.abs(toG - fromG) > Math.max(25, 0.3 * fromG);

type CatalogRow = typeof catalogItems.$inferSelect;
export interface Verified {
  row: CatalogRow;
  /** a product the catalog didn't have, added by this call */
  created: boolean;
  /** a retired row of this product, brought back under its old id by this call */
  revived: boolean;
  /** the catalog_edits row this call wrote, or for an unchanged call the row's latest:
   *  what revert_catalog_edit takes to undo it */
  editId: number;
  /** the row already stood exactly as asked (the same call sent twice): nothing written */
  unchanged: boolean;
  /** what the person should hear about what was written, each undone by
   *  revert_catalog_edit with editId: a scale weight that replaced the maker's, or one
   *  that names no size on gear sold by size */
  warnings: string[];
}

/** A one-line text argument, tidied and capped, its apostrophe straight as the seed spells
 *  it (the seed finds a row by its exact name); "" when absent or not a string. */
const text = (v: unknown, max: number) => (typeof v === "string" ? foldApostrophes(tidyText(v)).slice(0, max) : "");

/** The vocabulary's own spelling of a label, matched through the search fold (case,
 *  accents and punctuation aside: "arcteryx" or "Arc’teryx" → "Arc'teryx"), else the label
 *  with its first letter raised. A verified row joins the brand and gear-type suggestions
 *  (catalogBrands, catalogGearTypes), and the audit fails a brand spelled two ways. */
function spelledAs(label: string, vocabulary: string[], loose?: (s: string) => string): string {
  const key = normKey(label);
  const found = vocabulary.find((v) => normKey(v) === key) ?? (loose && vocabulary.find((v) => loose(v) === loose(label)));
  return found ?? label.charAt(0).toUpperCase() + label.slice(1);
}

/** A gear type folded with a plural "s" put aside, for a second look when the exact fold
 *  finds nothing: the first chat wrote "Bungee cords" beside the vocabulary's "Bungee
 *  cord", and the suggestions then offered both. Only ever matches a spelling that is
 *  already in the vocabulary, so it can't invent one. */
const gearTypeKey = (label: string) => normKey(label).replace(/s$/, "");

const asRuleRow = (r: CatalogRow): RuleRow => ({
  brand: r.brand,
  name: r.name,
  variant: r.variant,
  commonName: r.commonName,
  categoryHint: r.categoryHint,
  weightMg: Number(r.weightMg),
  weightSource: r.weightSource,
  sourceUrl: r.sourceUrl,
  sourceQuote: r.sourceQuote,
});

/** The product's other live rows (same brand and name through the search fold, as the
 *  audit groups them), for the house rules that compare a row with its siblings. */
async function siblingsOf(db: Db, brand: string | null, name: string, exceptId: number | undefined): Promise<RuleRow[]> {
  const rows = await db
    .select()
    .from(catalogItems)
    .where(and(eq(catalogItems.status, "active"), sql`lower(${catalogItems.name}) = lower(${name})`));
  return rows.filter((r) => r.id !== exceptId && normKey(r.brand) === normKey(brand) && normKey(r.name) === normKey(name)).map(asRuleRow);
}

/** The product a verification is about: what the row will be called, and, for a precheck
 *  that reads the variant's sizes, the gear type and kind they are read by. */
export interface VerifyIdentity {
  brand: string | null;
  name: string;
  variant: string | null;
  commonName?: string | null;
  categoryHint?: string | null;
}

/**
 * Verify a catalog row, or add a product the catalog doesn't have as a verified row.
 * Answers the row, or a sentence saying what to change, for the model to read.
 * `precheck` sees the product once it is known and can refuse before anything is
 * written: the piece of My Gear the call also links has to be the same product.
 */
export async function verifyCatalogItem(
  db: Db,
  userId: number,
  args: Record<string, unknown>,
  precheck?: (identity: VerifyIdentity) => string | undefined,
): Promise<Verified | string> {
  // ---- the weight and its evidence ----
  const grams = typeof args.weight_g === "number" ? args.weight_g : NaN;
  const weightMg = Math.round(grams * 1000);
  if (!Number.isFinite(grams) || weightMg <= 0 || weightMg > UNIT_WEIGHT_MAX_MG) {
    return `weight_g is the weight of one unit in grams, above 0 and up to ${UNIT_WEIGHT_MAX_MG / 1e6} kg.`;
  }
  const confirmed = args.weight_confirmed === true;
  const source = args.weight_source ?? "manufacturer";
  if (!VERIFY_SOURCES.includes(source as (typeof VERIFY_SOURCES)[number])) return `weight_source is manufacturer (the maker's published weight) or measured (weighed on the person's own scale).`;
  const sourceUrl = typeof args.source_url === "string" && args.source_url.trim() ? args.source_url.trim() : null;
  if (sourceUrl && sourceUrl.length > VERIFY_URL_MAX) return `source_url is at most ${VERIFY_URL_MAX} characters; give the page's own address.`;
  if (sourceUrl && !isHttpUrl(sourceUrl)) return "source_url must be an http or https address.";
  const quote = typeof args.quote === "string" ? tidyQuote(args.quote) : "";
  if (quote.length > VERIFY_QUOTE_MAX) return `quote is at most ${VERIFY_QUOTE_MAX} characters; quote only the line that states the weight.`;
  if (source === "manufacturer") {
    if (!sourceUrl) return "A manufacturer weight needs source_url, the maker's page that publishes it.";
    if (!quote) return "A manufacturer weight needs quote, the maker's own line that states the weight.";
    if (!quoteBacksWeight(quote, grams)) {
      return `The quote doesn't state ${grams} g: none of its weights is within 8 g or 5% of it (a fabric's weight per area or a rate doesn't count). Check the number, or quote the line that gives this weight.`;
    }
  }
  // a scale weight is kept with a line saying so: what the research would cite for a
  // measured row, and what the audit reads as an as-carried figure on a pouch meal
  const storedQuote = quote || (source === "measured" ? `Weighed on an admin's scale: ${grams} g` : null);
  const notes = text(args.notes, VERIFY_NOTES_MAX);
  // the gear type in its canonical case and alias ("tent" → "Tent"), which the audit holds
  // every row to, then spelled as the verified rows already spell it, a plural folded onto
  // the singular there or the other way round ("Hiking pant" → "Hiking pants"); the kind
  // of gear and the sizes are read by that spelling, the one the row will carry
  const typedType = normalizeGearType(text(args.gear_type, MAX_GEAR_TYPE_LEN));
  const gearTypes = await catalogGearTypes(db);
  const gearType = typedType ? spelledAs(typedType, gearTypes, gearTypeKey) : "";
  const category = args.category == null ? null : String(args.category).trim().toLowerCase();
  if (category != null && !CATEGORIES.includes(category)) return `category is one of ${CATEGORIES.join(", ")}.`;
  // the rows the person checked are other products
  const distinct = args.distinct_from ?? [];
  if (!Array.isArray(distinct) || !distinct.every(isCatalogId)) return "distinct_from lists the ids of the catalog rows a refusal named as looking like the same product.";
  const typedBrand = async () => {
    const b = text(args.brand, MAX_BRAND_LEN);
    return b ? spelledAs(b, await catalogBrands(db)) : null;
  };
  const typedVariant = () => normalizeVariant(text(args.variant, MAX_VARIANT_LEN)) || null;

  // ---- the row: one that exists (renamed if asked), or a new product ----
  let current: CatalogRow | undefined;
  let identity: VerifyIdentity;
  let fresh = false;
  if (args.catalog_id != null) {
    if (!isCatalogId(args.catalog_id)) return "catalog_id is a catalog row's id, a whole number from search_catalog.";
    [current] = await db.select().from(catalogItems).where(eq(catalogItems.id, args.catalog_id)).limit(1);
    if (!current) return `No catalog row has id ${args.catalog_id}.`;
    // brand, name or variant beside a catalog_id put the row right as it is verified: a
    // community row typed as it was on someone's list rarely meets the house style
    if (args.name !== undefined && !text(args.name, MAX_ITEM_NAME_LEN)) return "name can't be cleared; leave it out to keep the row's own.";
    identity = {
      brand: args.brand === undefined ? current.brand : await typedBrand(),
      name: args.name === undefined ? current.name : text(args.name, MAX_ITEM_NAME_LEN),
      variant: args.variant === undefined ? current.variant : typedVariant(),
    };
  } else {
    const name = text(args.name, MAX_ITEM_NAME_LEN);
    if (!name) return "Give catalog_id for a row in the catalog, or name (with brand, variant and gear_type) for a product it doesn't have.";
    if (!gearType) return "A new product needs gear_type, what it is (\"Tent\", \"Rain jacket\"), the label a pick fills in.";
    identity = { brand: await typedBrand(), name, variant: typedVariant() };
    const { brand, variant } = identity;
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
      // A near match is only a likeness: the person can say it is another product, by
      // the row's own id. Every near match is named at once, so the rows let past are the
      // ones the person checked and nothing else. Without it, the only way past was to
      // change the text until it stopped matching.
      const matches = await catalogMatches(db, brand, name, variant);
      const near = matches.filter((m) => !distinct.includes(m.id));
      if (near.length) {
        const ids = [...matches.filter((m) => distinct.includes(m.id)), ...near].map((m) => m.id).join(", ");
        const rows = near.map((m) => `${m.id}, ${itemDisplayName(m.brand, m.name, m.variant)}`);
        const dont = "don't rename it to get past this.";
        if (rows.length === 1) {
          return `Catalog row ${rows[0]}, looks like the same product; pass catalog_id ${near[0]!.id} to verify it, or give the size that tells them apart. If the person confirms it is a different product, send distinct_from: [${ids}]; ${dont}`;
        }
        return `Catalog rows ${rows.join("; ")} look like the same product; pass the catalog_id of the one it is to verify that row, or give the size that tells them apart. If the person confirms it is none of them, send distinct_from: [${ids}]; ${dont}`;
      }
      fresh = true;
    }
  }
  const display = itemDisplayName(identity.brand, identity.name, identity.variant);
  const refused = precheck?.({ ...identity, commonName: gearType || current?.commonName || null, categoryHint: category ?? categoryForGearType(gearType) ?? current?.categoryHint ?? null });
  if (refused) return refused;

  // what the call would make of the row's gear type and kind: the gear type given, or the
  // row's own (either joins the suggestions once verified), and the category given, else
  // the one a given gear type names
  const typedLabel = gearType || current?.commonName?.trim() || "";
  const askedLabel = typedLabel ? spelledAs(typedLabel, gearTypes, gearTypeKey) : null;
  const askedKind = category ?? categoryForGearType(gearType);

  // A retired row: one merged into a successor is verified there; one removed outright
  // comes back under its old id, as the seed's upsert brings back a row the research names
  // again, so the lists that kept holding that id pick it up. A live research row takes a
  // corrected maker's weight and citation, and nothing else: its name and gear type are the
  // research's, and so is its weight's being the maker's. That holds after a first
  // correction too, when the row's verifier is set and only its edit history says where it
  // came from, which is read only when the call would change something the research owns.
  let revive = false;
  let research = false;
  if (current && current.status !== "active") {
    if (current.mergedIntoId) return `Row ${current.id} was retired into row ${current.mergedIntoId}; verify that one.`;
    revive = true;
  } else if (current) {
    const renames = identity.brand !== current.brand || identity.name !== current.name || identity.variant !== current.variant;
    const retypes = (gearType !== "" && normKey(gearType) !== normKey(current.commonName)) || (category != null && category !== current.categoryHint);
    const measures = source === "measured";
    // the write below would respell the gear type, or rewrite the kind or the search terms
    // the build gave the row: kept as they are on a research row, so its search still works
    const touches =
      (askedLabel != null && (askedLabel !== current.commonName || (normKey(askedLabel) || null) !== current.searchTerms)) ||
      (askedKind != null && askedKind !== current.categoryHint);
    research = seedManaged(current) || ((renames || retypes || measures || touches) && current.verifiedBy != null && (await wasResearchRow(db, current.id)));
    if (research && measures) {
      return `Row ${current.id} comes from Mahonia's research files, which hold the maker's published weight: a weight from the person's own scale belongs on their piece of My Gear (edit_my_gear's weight_g), not on the catalog's row.`;
    }
    if (research && (renames || retypes)) {
      return `Row ${current.id} comes from Mahonia's research files: verify_catalog_item can correct its weight and citation from the maker's page, but a new name or gear type belongs in seed/_research.`;
    }
  }

  // ---- what waits for the person: each concern the call raises, named in one refusal ----
  // the kind asked for, else the row's own; a research row keeps its own (a different
  // one was refused above)
  const typedKind = research ? null : askedKind;
  const kind = typedKind ?? current?.categoryHint ?? "other";
  const [lo, hi] = RANGE_G[kind] ?? RANGE_G.other!;
  const concerns: string[] = [];
  const warnings: string[] = [];
  if (grams < lo || grams > hi) {
    concerns.push(`${grams} g is outside ${lo}–${hi} g, the usual range for ${kind}: check the number (grams, for one, a pair as the pair) and the category.`);
  }
  const nowG = current ? Number(current.weightMg) / 1000 : 0;
  if (current && nowG > 0 && bigChange(nowG, grams)) {
    concerns.push(`Row ${current.id}, ${itemDisplayName(current.brand, current.name, current.variant)}, weighs ${nowG} g now, and ${grams} g is a change of more than 30%: check it is the right row, the right size and the right number.`);
  }
  // A scale weight over a maker's published one replaces the maker's figure and its quote
  // for everyone who uses the catalog (the undo keeps both), a row brought back included.
  // Often the person meant their own piece, which takes its own weight without touching
  // the shared row, so the answer says so, and how to put the maker's back.
  if (source === "measured" && current?.weightSource === "manufacturer") {
    let from = "";
    try {
      from = current.sourceUrl ? `, from ${new URL(current.sourceUrl).hostname.replace(/^www\./, "")}` : "";
    } catch {}
    warnings.push(`Row ${current.id}, ${itemDisplayName(current.brand, current.name, current.variant)}, carried the maker's published weight (${nowG} g${from}), and this scale weight replaced it, and its quote, for everyone who uses the catalog. If the person meant only their own piece, revert_catalog_edit with edit_id puts the maker's back, and edit_my_gear's weight_g records theirs.`);
  }

  // the gear type the row will carry: a research row keeps its own as it stands
  const label = research ? current!.commonName : askedLabel;
  const effectiveUrl = sourceUrl ?? current?.sourceUrl ?? null;
  // One weighing is one size: on gear sold by size, a scale weight with no size in the
  // variant reads as every size's, unless the product comes in one size. A size the reader
  // can't place ("Men's 32x30") counts as one.
  if (source === "measured" && soldByOf(label).includes("size") && !namesSize(identity.variant)) {
    warnings.push(`${label} is sold by size, and this scale weight names none, so it now reads as every size's. Unless it is sold in one size only, send verify_catalog_item again with the row's catalog_id and the size that was weighed in variant ("Men's Medium", "Men's US 9"); if that size is already a row of its own, revert_catalog_edit with edit_id undoes this one instead.`);
  }

  // ---- the same call twice: the row already stands as asked ----
  if (
    current &&
    current.verifiedBy != null &&
    current.status === "active" &&
    Number(current.weightMg) === weightMg &&
    current.weightSource === source &&
    current.sourceUrl === effectiveUrl &&
    current.sourceQuote === storedQuote &&
    current.brand === identity.brand &&
    current.name === identity.name &&
    current.variant === identity.variant &&
    current.categoryHint === kind &&
    current.commonName === label
  ) {
    const [last] = await db
      .select({ id: catalogEdits.id })
      .from(catalogEdits)
      .where(and(eq(catalogEdits.catalogItemId, current.id), eq(catalogEdits.status, "applied")))
      .orderBy(desc(catalogEdits.id))
      .limit(1);
    if (last) return { row: current, created: false, revived: false, editId: last.id, unchanged: true, warnings };
  }

  // ---- the house style: what the build would refuse in this row ----
  const ruleRow: RuleRow = { ...identity, commonName: label, categoryHint: kind, weightMg, weightSource: source as string, sourceUrl: effectiveUrl, sourceQuote: storedQuote };
  // a research row graduates back into its own research file, not verified-in-app.json
  const problems = houseRuleProblems(ruleRow, await siblingsOf(db, identity.brand, identity.name, current?.id), research ? "research" : undefined);
  if (problems.length) {
    const fix = research
      ? "check source_url is the maker's own page and quote its line that states the weight"
      : args.catalog_id != null
        ? "pass brand, name, variant or gear_type beside the catalog_id to put the row right"
        : "change the brand, name, variant or gear type";
    return `The catalog's house style refuses ${display}: ${problems.join(" ")} To fix it, ${fix}, and send it again.`;
  }

  if (concerns.length && !confirmed) {
    if (concerns.length === 1) return `${concerns[0]} If the person confirms it, send weight_confirmed: true.`;
    return `${concerns.length} things wait for the person: ${concerns.map((c, i) => `(${i + 1}) ${c}`).join(" ")} If they confirm all of it, send weight_confirmed: true.`;
  }

  // ---- volume: a loop that went wrong stops here ----
  // only an admin's verification keeps an undo snapshot, so these are the tool's own writes
  const [counted] = await db
    .select({ n: sql<number>`count(*)` })
    .from(catalogEdits)
    .where(and(isNotNull(catalogEdits.undo), gt(catalogEdits.createdAt, sql`now() - interval '1 hour'`)));
  const recent = Number(counted?.n ?? 0);
  if (recent >= VERIFY_HOURLY_MAX) {
    return `${recent} catalog verifications in the last hour is the most the tool takes. Look over them with catalog_changes, and carry on in an hour.`;
  }

  const verified = { weightMg, weightSource: source as string, sourceUrl, sourceQuote: storedQuote, verified: true, verifiedBy: userId, updatedAt: new Date() };

  // The edit history and the row are written in ONE statement (the edit as a data-modifying
  // CTE), so neither lands without the other: an "applied" edit for a change that never
  // happened would hand revert_catalog_edit a weight to restore that the row never left.
  if (fresh) {
    try {
      const added = db.$with("added").as(
        db
          .insert(catalogItems)
          .values({
            ...identity,
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
      return { row: row!, created: true, revived: false, editId: edit!.id, unchanged: false, warnings };
    } catch (e) {
      // the identity index: the same product added a moment ago
      if (!isUniqueViolation(e)) throw e;
      return `${display} was just added to the catalog; search for it and pass its catalog_id.`;
    }
  }

  const row = current!;
  // what the update replaces, kept on the edit: revert_catalog_edit puts all of it back,
  // not the weight alone
  const undo: CatalogEditUndo = {
    brand: row.brand,
    name: row.name,
    variant: row.variant,
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
  try {
    const [written] = await db
      .with(edit)
      .update(catalogItems)
      .set({
        ...verified,
        ...identity,
        // a scale weight usually comes with no link: the row keeps the one it had
        sourceUrl: effectiveUrl,
        ...(typedKind ? { categoryHint: typedKind } : {}),
        ...(label && !research ? { commonName: label, searchTerms: normKey(label) || null } : {}),
        ...(revive ? { status: "active", mergedIntoId: null } : {}),
      })
      .where(eq(catalogItems.id, row.id))
      // the edit's id, read from the CTE the same statement wrote it in
      .returning({ ...getTableColumns(catalogItems), editId: sql<number>`(select ${sql.identifier("id")} from ${sql.identifier("edit")})` });
    const { editId, ...updated } = written!;
    return { row: updated, created: false, revived: revive, editId: Number(editId), unchanged: false, warnings };
  } catch (e) {
    // a rename onto the identity of another row
    if (!isUniqueViolation(e)) throw e;
    return `${display} is already another catalog row, maybe a retired one; to verify that one instead, send its brand, name and variant without catalog_id.`;
  }
}

/** Whether a row was a research row before a verification stamped it: an applied edit
 *  whose undo snapshot has it verified with no verifier (seedManaged). Once corrected, a
 *  research row's own fields no longer say so, and the research still names it. */
async function wasResearchRow(db: Db, id: number): Promise<boolean> {
  const [found] = await db
    .select({ id: catalogEdits.id })
    .from(catalogEdits)
    .where(
      and(
        eq(catalogEdits.catalogItemId, id),
        eq(catalogEdits.status, "applied"),
        sql`${catalogEdits.undo}->>'verified' = 'true'`,
        // a JSON null, not a missing key: the snapshot of a product the tool added has neither
        sql`${catalogEdits.undo}->'verifiedBy' = 'null'::jsonb`,
      ),
    )
    .limit(1);
  return found != null;
}

/**
 * revert_catalog_edit's work: undo one applied edit, an admin's verification or a
 * community correction, and answer the row as it now stands, or a sentence saying why not.
 * The weight goes back, and for a verification everything else it changed (CatalogEditUndo).
 */
export async function undoCatalogEdit(db: Db, editId: unknown): Promise<{ row: CatalogRow } | string> {
  // catalog_edits.id is the same PostgreSQL serial range as catalog_items.id
  if (!isCatalogId(editId)) return "edit_id is a catalog edit's id, a whole number from verify_catalog_item or catalog_changes.";
  const [edit] = await db.select().from(catalogEdits).where(eq(catalogEdits.id, editId)).limit(1);
  if (!edit) return `No catalog edit has id ${editId}.`;
  const rowId = Number(edit.catalogItemId);
  // only applied edits moved a weight
  if (edit.status === "reverted") return `Edit ${editId} is already undone.`;
  if (edit.status !== "applied") return `Edit ${editId} is ${edit.status} and never moved the weight; there is nothing to undo.`;
  // only the most recent applied edit: undoing an older one would throw the newer away unseen
  const [newer] = await db
    .select({ id: catalogEdits.id })
    .from(catalogEdits)
    .where(and(eq(catalogEdits.catalogItemId, rowId), eq(catalogEdits.status, "applied"), gt(catalogEdits.id, editId)))
    .orderBy(desc(catalogEdits.id))
    .limit(1);
  if (newer) return `Row ${rowId} has a newer applied edit, ${newer.id}; undo the newest first.`;
  if (edit.undo) {
    // a verification: once the seed has taken the row over, the research owns it and the
    // snapshot would hand it back to the database
    const [item] = await db.select().from(catalogItems).where(eq(catalogItems.id, rowId)).limit(1);
    if (item && seedManaged(item)) return `Row ${rowId} now comes from Mahonia's research files; a change to it belongs in seed/_research.`;
  }
  let row: CatalogRow | undefined;
  try {
    [row] = await db
      .update(catalogItems)
      .set({ weightMg: Number(edit.oldWeightMg), updatedAt: new Date(), ...(edit.undo ?? {}) })
      // only while the row holds what the edit wrote: a weight set since (the seed's, when
      // the research took the row over) isn't the edit's to put back
      .where(and(eq(catalogItems.id, rowId), eq(catalogItems.weightMg, Number(edit.newWeightMg))))
      .returning();
  } catch (e) {
    // a verification that renamed its row, undone after another row took the old name
    if (!isUniqueViolation(e)) throw e;
    return `Edit ${editId} renamed its row, and another row now has the old name, so it can't be put back. Rename one of them first.`;
  }
  if (!row) return `Row ${rowId} has changed since edit ${editId}, so there is nothing of it to undo; verify the row again to set its weight.`;
  await db.update(catalogEdits).set({ status: "reverted" }).where(eq(catalogEdits.id, editId));
  return { row };
}

/** One line of the catalog's edit history (catalog_edits), applied: where a verification's
 *  date, source and notes are kept, and what revert_catalog_edit reads and undoes. */
function editRow(catalogItemId: number | SQL, oldWeightMg: number, newWeightMg: number, sourceUrl: string | null, reason: string, undo: CatalogEditUndo) {
  return { catalogItemId, oldWeightMg, newWeightMg, sourceUrl, reason, status: "applied", undo };
}
