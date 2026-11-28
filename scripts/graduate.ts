// The pieces of catalog:graduate (scripts/catalog-graduate.ts), apart from its run so a
// test can drive them on PGlite: the in-app verified rows, each as a research row; a
// research row corrected in the app, written back into its own row of its own file; and
// the merge of the rest into the file they graduate to.

import { and, eq, isNotNull } from "drizzle-orm";
import { catalogItems } from "../server/db/schema";
import type { Db } from "../server/utils/db";
import { normalizeVariant, tidyQuote } from "../shared/catalogQuality";
import { identity, specToMg } from "./catalogCsv";
import type { Unit } from "../shared/types";
import { formatResearchFile, GRADUATED_FILE_NAME, type ResearchRow } from "./research";

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
    ...(r.sourceQuote ? { quote: tidyQuote(r.sourceQuote) } : {}),
  };
}

/** The live rows an admin verified in the app: the ones graduate writes out. */
export async function inAppVerified(db: Db): Promise<Row[]> {
  return db.select().from(catalogItems).where(and(isNotNull(catalogItems.verifiedBy), eq(catalogItems.status, "active")));
}

/** The in-app verified rows the research doesn't name at all: new products added through
 *  the connector, which no reseed will ever mention since the CSV never reaches them. */
export function notInResearch<T extends Pick<Row, "brand" | "name" | "variant">>(
  rows: readonly T[],
  research: readonly { brand: string | null; name: string; variant: string | null }[],
): T[] {
  const named = new Set(research.map((r) => identity(r.brand, r.name, r.variant)));
  return rows.filter((r) => !named.has(identity(r.brand, r.name, r.variant)));
}

/** A weight and its link, as research or the database holds them. */
export interface Cited {
  weightMg: number | null;
  sourceUrl: string | null;
}

/**
 * For each in-app row that began as a research row, the research's weight and link when
 * it was verified: the pair the seed last wrote on it (seed_weight_mg, seed_source_url),
 * which no verification touches and the reseed leaves alone while the row is held. A
 * product added in the app has none. Keyed by researchIdentity. If the research row
 * differs from this today, the research changed after the verification, and graduating
 * would write over that change.
 */
export function researchWhenVerified(rows: readonly Pick<Row, "brand" | "name" | "variant" | "seedWeightMg" | "seedSourceUrl">[]): Map<string, Cited> {
  const out = new Map<string, Cited>();
  for (const row of rows) {
    if (row.seedWeightMg != null) out.set(researchIdentity(row), { weightMg: Number(row.seedWeightMg), sourceUrl: row.seedSourceUrl });
  }
  return out;
}

/** A research row's weight in milligrams as the build reads it, or null where it can't. */
function researchMg(row: Record<string, unknown>): number | null {
  try {
    const secondary = typeof row.weight_secondary === "string" ? row.weight_secondary : null;
    return specToMg(Number(row.weight_value), String(row.weight_unit ?? "").trim() as Unit, secondary);
  } catch {
    return null;
  }
}

/** The file's rows with these merged in, a row of the same identity replaced. */
export function mergeResearch(existing: ResearchRow[], incoming: ResearchRow[]): ResearchRow[] {
  const key = (r: ResearchRow) => identity(r.brand ?? null, r.name ?? "", r.variant ?? null);
  const byKey = new Map(existing.map((r) => [key(r), r]));
  for (const r of incoming) byKey.set(key(r), r);
  return [...byKey.values()];
}

/** A research row's identity as the catalog holds it once built: brand and name trimmed,
 *  the variant in the catalog's style (the build turns a research "M" into "Medium"), so a
 *  row from the database finds the research row it was seeded from. */
export function researchIdentity(r: { brand?: unknown; name?: unknown; variant?: unknown }): string {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return identity(str(r.brand), str(r.name), normalizeVariant(str(r.variant)));
}

/**
 * A research file's rows with those of these identities (researchIdentity) given the weight
 * and citation an admin verified in the app: the weight in grams, its source, link and quote
 * (no quote if the graduated row has none), and no weight_secondary or quote_unchecked, which
 * were about the figure and quote it replaces. Every other key of the row stays, and every
 * other row is the one passed in. Answers the rows, the identities it replaced, and what
 * each replaced row said before.
 */
export function rewriteResearchRows(
  rows: readonly unknown[],
  incoming: Map<string, ResearchRow>,
): { rows: unknown[]; replaced: Set<string>; before: Map<string, Cited> } {
  const replaced = new Set<string>();
  const before = new Map<string, Cited>();
  const out = [...rows];
  // from the end backwards: the order the run lists what it replaced in, and of two rows
  // with one identity, the first in the file is the one `before` is left holding
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const key = researchIdentity(row);
    const graduated = incoming.get(key);
    if (!graduated) continue;
    const next: Record<string, unknown> = {
      ...row,
      weight_value: graduated.weight_value,
      weight_unit: "g",
      weight_source: graduated.weight_source,
      source_url: graduated.source_url,
    };
    if (graduated.quote) next.quote = graduated.quote;
    else delete next.quote;
    delete next.weight_secondary;
    delete next.quote_unchecked;
    out[i] = next;
    replaced.add(key);
    const r = row as Record<string, unknown>;
    before.set(key, { weightMg: researchMg(r), sourceUrl: typeof r.source_url === "string" ? r.source_url.trim() || null : null });
  }
  return { rows: out, replaced, before };
}

/** One research row graduate writes over: what the research said, what the app holds, and
 *  whether the research changed after the verification (so the write throws that away). */
export interface Overwrite {
  file: string;
  key: string;
  research: Cited;
  app: Cited;
  /** What the research said when the row was verified; null for a product added in the app. */
  whenVerified: Cited | null;
  researchMoved: boolean;
}

const GRADUATED_COMMENT = "Rows verified in the app (verify_catalog_item), written out by npm run catalog:graduate.";

/**
 * Where each graduated row goes. `files` is every research file, verified-in-app.json
 * among them when it exists. One the research already has, in any file but
 * verified-in-app.json, is written back into that row (rewriteResearchRows): a second row
 * of the same identity there would fail the build. The rest merge into verified-in-app.json
 * as they always have. Every file written is written whole, in the house layout
 * (formatResearchFile), which a research file is already in, so only the rows that changed
 * differ. Answers each file's new text by name, how many rows went back into each research
 * file, how many went to verified-in-app.json, and every such row as an Overwrite, so the
 * run can say what it replaced. `whenVerified` (researchWhenVerified) is what lets it tell
 * a maker's re-spec from a research edit made after the verification.
 */
export function planGraduation(
  incoming: ResearchRow[],
  files: { file: string; raw: string }[],
  whenVerified: ReadonlyMap<string, Cited> = new Map(),
): { writes: Map<string, string>; inPlace: Map<string, number>; toGraduated: number; overwrites: Overwrite[] } {
  const wanted = new Map(incoming.map((r) => [researchIdentity(r), r]));
  const writes = new Map<string, string>();
  const inPlace = new Map<string, number>();
  const placed = new Set<string>();
  const overwrites: Overwrite[] = [];
  for (const { file, raw } of files) {
    if (file === GRADUATED_FILE_NAME) continue;
    // a file that isn't JSON throws here, before anything is written; the build and the
    // audit refuse such a file too
    const data = JSON.parse(raw) as { _comment?: unknown; rows?: unknown } | null;
    const held = data?.rows;
    if (!Array.isArray(held)) continue;
    const { rows, replaced, before } = rewriteResearchRows(held, wanted);
    if (!replaced.size) continue;
    // the file's note goes with it
    writes.set(file, formatResearchFile({ ...data, rows }));
    inPlace.set(file, replaced.size);
    for (const key of replaced) {
      placed.add(key);
      const research = before.get(key)!;
      const graduated = wanted.get(key)!;
      const app = { weightMg: Math.round(Number(graduated.weight_value) * 1000), sourceUrl: graduated.source_url ?? null };
      const then = whenVerified.get(key) ?? null;
      const researchMoved = then != null && (then.weightMg !== research.weightMg || then.sourceUrl !== research.sourceUrl);
      overwrites.push({ file, key, research, app, whenVerified: then, researchMoved });
    }
  }
  const rest = incoming.filter((r) => !placed.has(researchIdentity(r)));
  if (rest.length) {
    const graduatedRaw = files.find((f) => f.file === GRADUATED_FILE_NAME)?.raw;
    const before = graduatedRaw ? (JSON.parse(graduatedRaw) as { _comment?: unknown; rows?: ResearchRow[] }) : {};
    const rows = mergeResearch(before.rows ?? [], rest);
    writes.set(GRADUATED_FILE_NAME, formatResearchFile({ _comment: before._comment ?? GRADUATED_COMMENT, rows }));
  }
  return { writes, inPlace, toGraduated: rest.length, overwrites };
}
