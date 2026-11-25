// The pieces of catalog:graduate (scripts/catalog-graduate.ts), apart from its run so a
// test can drive them on PGlite: the in-app verified rows, each as a research row; a
// research row corrected in the app, written back into its own file in place; and the
// merge of the rest into the file they graduate to.

import { join } from "node:path";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { catalogEdits, catalogItems } from "../server/db/schema";
import type { Db } from "../server/utils/db";
import { normalizeVariant, tidyQuote } from "../shared/catalogQuality";
import { specToMg } from "./catalogCsv";
import type { Unit } from "../shared/types";
import { RESEARCH_DIR } from "./paths";
import { formatResearchFile, GRADUATED_FILE_NAME, inlineJson, type ResearchRow } from "./research";
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
 * For each in-app row that began as a research row, the research's weight and link when a
 * verification first stamped it: the latest applied verification whose undo snapshot has
 * the row seed-managed (verified, no verifier, as wasResearchRow reads it). Keyed by
 * researchIdentity. If the research row differs from this today, the research changed
 * after the verification, and graduating would write over that change.
 */
export async function researchWhenVerified(db: Db, rows: readonly Row[]): Promise<Map<string, Cited>> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, Cited>();
  if (!byId.size) return out;
  const stamps = await db
    .select({ itemId: catalogEdits.catalogItemId, oldWeightMg: catalogEdits.oldWeightMg, sourceUrl: sql<string | null>`${catalogEdits.undo}->>'sourceUrl'` })
    .from(catalogEdits)
    .where(
      and(
        inArray(catalogEdits.catalogItemId, [...byId.keys()]),
        eq(catalogEdits.status, "applied"),
        sql`${catalogEdits.undo}->>'verified' = 'true'`,
        sql`${catalogEdits.undo}->'verifiedBy' = 'null'::jsonb`,
      ),
    )
    .orderBy(asc(catalogEdits.id));
  // ascending, so the latest stamp of each row is the one left in the map
  for (const { itemId, oldWeightMg, sourceUrl } of stamps) {
    const row = byId.get(itemId)!;
    out.set(researchIdentity(row), { weightMg: Number(oldWeightMg), sourceUrl });
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
  return identity(str(r.brand) || null, str(r.name), normalizeVariant(str(r.variant)) || null);
}

/** Where each object in a research file's top-level "rows" array sits in its text: read by
 *  bracket matching that steps over strings and their escapes, so a row can be put back in
 *  place and every other byte of the file left as it was. */
function rowSpans(raw: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const open: string[] = [];
  // the root object's last string, which is the key by the time a [ follows it
  let key: string | null = null;
  let inRows = false;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      const from = i;
      for (i++; i < raw.length && raw[i] !== '"'; i++) if (raw[i] === "\\") i++;
      if (open.length === 1) key = raw.slice(from + 1, i);
    } else if (c === "{" || c === "[") {
      if (open.length === 1 && c === "[" && key === "rows") inRows = true;
      else if (inRows && open.length === 2 && c === "{") start = i;
      open.push(c);
    } else if (c === "}" || c === "]") {
      open.pop();
      if (inRows && open.length === 2 && c === "}") spans.push({ start, end: i + 1 });
      else if (inRows && open.length === 1) break;
    }
  }
  return spans;
}

const spacedJson = inlineJson;

/** A row written as its own slice of the file was: on one line, spaced or tight, or one key
 *  a line at the slice's indent, nested values inline unless the slice opened them on lines
 *  of their own. `indent` is what stood before the row's { on its line. */
function restyle(row: Record<string, unknown>, slice: string, indent: string): string {
  if (!slice.includes("\n")) return slice.includes('": ') ? spacedJson(row) : JSON.stringify(row);
  const lines = slice.split("\n");
  const second = lines[1]!.match(/^[ \t]*/)![0];
  const unit = (second.startsWith(indent) ? second.slice(indent.length) : second) || "  ";
  if (lines.slice(1, -1).some((l) => /[[{]\s*$/.test(l))) return JSON.stringify(row, null, unit).replace(/\n/g, `\n${indent}`);
  const keys = Object.entries(row).map(([k, v]) => `${indent}${unit}${JSON.stringify(k)}: ${spacedJson(v)}`);
  return `{\n${keys.join(",\n")}\n${indent}}`;
}

/**
 * A research file with its rows of these identities (researchIdentity) given the weight and
 * citation an admin verified in the app: the weight in grams, its source, link and quote (no
 * quote if the graduated row has none), and no weight_secondary, which would be stale. Every
 * other key stays, in its order, and every other byte of the file is untouched; the row is
 * written in its own slice's style. Answers the new text, the identities it replaced, and
 * what each replaced row said before.
 */
export function rewriteResearchRows(
  raw: string,
  incoming: Map<string, ResearchRow>,
): { text: string; replaced: Set<string>; before: Map<string, Cited> } {
  const replaced = new Set<string>();
  const before = new Map<string, Cited>();
  let text = raw;
  // from the end backwards, so the spans still ahead keep their offsets
  for (const { start, end } of rowSpans(raw).reverse()) {
    const slice = raw.slice(start, end);
    let row: unknown;
    try {
      row = JSON.parse(slice);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const key = researchIdentity(row);
    const graduated = incoming.get(key);
    if (!graduated) continue;
    const out: Record<string, unknown> = {
      ...row,
      weight_value: graduated.weight_value,
      weight_unit: "g",
      weight_source: graduated.weight_source,
      source_url: graduated.source_url,
    };
    if (graduated.quote) out.quote = graduated.quote;
    else delete out.quote;
    delete out.weight_secondary;
    const lineStart = raw.lastIndexOf("\n", start - 1) + 1;
    const indent = raw.slice(lineStart, start).match(/^[ \t]*/)![0];
    text = text.slice(0, start) + restyle(out, slice, indent) + text.slice(end);
    replaced.add(key);
    const r = row as Record<string, unknown>;
    before.set(key, { weightMg: researchMg(r), sourceUrl: typeof r.source_url === "string" ? r.source_url.trim() || null : null });
  }
  return { text, replaced, before };
}

/** One research row graduate writes over: what the research said, what the app holds, and
 *  whether the research changed after the verification (so the write throws that away). */
export interface Overwrite {
  file: string;
  key: string;
  research: Cited;
  app: Cited;
  /** What the row held when the verification stamped it, where the edit history says. */
  whenVerified: Cited | null;
  researchMoved: boolean;
}

const GRADUATED_COMMENT = "Rows verified in the app (verify_catalog_item), written out by npm run catalog:graduate.";

/**
 * Where each graduated row goes. One the research already has, in any file but
 * verified-in-app.json, is written back into that row in place (rewriteResearchRows): a
 * second row of the same identity there would fail the build. The rest merge into
 * verified-in-app.json as they always have. Answers each file's new text by name, how many
 * rows went back into each research file, how many went to verified-in-app.json, and every
 * in-place write as an Overwrite, so the run can say what it replaced. `whenVerified`
 * (researchWhenVerified) is what lets it tell a maker's re-spec from a research edit made
 * after the verification.
 */
export function planGraduation(
  incoming: ResearchRow[],
  files: { file: string; raw: string }[],
  graduatedRaw: string | null,
  whenVerified: ReadonlyMap<string, Cited> = new Map(),
): { writes: Map<string, string>; inPlace: Map<string, number>; toGraduated: number; overwrites: Overwrite[] } {
  const wanted = new Map(incoming.map((r) => [researchIdentity(r), r]));
  const writes = new Map<string, string>();
  const inPlace = new Map<string, number>();
  const placed = new Set<string>();
  const overwrites: Overwrite[] = [];
  for (const { file, raw } of files) {
    if (file === GRADUATED_FILE_NAME) continue;
    const { text, replaced, before } = rewriteResearchRows(raw, wanted);
    if (!replaced.size) continue;
    // in the house layout, whatever the row's slice looked like (catalog:format)
    writes.set(file, formatResearchFile(JSON.parse(text)));
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
    const before = graduatedRaw ? (JSON.parse(graduatedRaw) as { _comment?: string; rows?: ResearchRow[] }) : {};
    const rows = mergeResearch(before.rows ?? [], rest);
    writes.set(GRADUATED_FILE_NAME, formatResearchFile({ _comment: before._comment ?? GRADUATED_COMMENT, rows }));
  }
  return { writes, inPlace, toGraduated: rest.length, overwrites };
}
