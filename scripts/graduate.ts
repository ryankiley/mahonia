// The pieces of catalog:graduate (scripts/catalog-graduate.ts), apart from its run so a
// test can drive them on PGlite: the in-app verified rows, each as a research row; a
// research row corrected in the app, written back into its own file in place; and the
// merge of the rest into the file they graduate to.

import { join } from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import { catalogItems } from "../server/db/schema";
import type { Db } from "../server/utils/db";
import { normalizeVariant, tidyQuote } from "../shared/catalogQuality";
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
    ...(r.sourceQuote ? { quote: tidyQuote(r.sourceQuote) } : {}),
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

/** JSON with a space after every colon and comma, nested objects too: how most research
 *  files write a row on one line, and a nested value inside a pretty one. */
function spacedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(spacedJson).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${spacedJson(x)}`).join(", ")}}`;
  return JSON.stringify(v);
}

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
 * written in its own slice's style. Answers the new text and the identities it replaced.
 */
export function rewriteResearchRows(raw: string, incoming: Map<string, ResearchRow>): { text: string; replaced: Set<string> } {
  const replaced = new Set<string>();
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
  }
  return { text, replaced };
}

const GRADUATED_COMMENT = "Rows verified in the app (verify_catalog_item), written out by npm run catalog:graduate.";

/**
 * Where each graduated row goes. One the research already has, in any file but
 * verified-in-app.json, is written back into that row in place (rewriteResearchRows): a
 * second row of the same identity there would fail the build. The rest merge into
 * verified-in-app.json as they always have. Answers each file's new text by name, how many
 * rows went back into each research file, and how many went to verified-in-app.json.
 */
export function planGraduation(
  incoming: ResearchRow[],
  files: { file: string; raw: string }[],
  graduatedRaw: string | null,
): { writes: Map<string, string>; inPlace: Map<string, number>; toGraduated: number } {
  const wanted = new Map(incoming.map((r) => [researchIdentity(r), r]));
  const writes = new Map<string, string>();
  const inPlace = new Map<string, number>();
  const placed = new Set<string>();
  for (const { file, raw } of files) {
    if (file === GRADUATED_FILE_NAME) continue;
    const { text, replaced } = rewriteResearchRows(raw, wanted);
    if (!replaced.size) continue;
    writes.set(file, text);
    inPlace.set(file, replaced.size);
    for (const key of replaced) placed.add(key);
  }
  const rest = incoming.filter((r) => !placed.has(researchIdentity(r)));
  if (rest.length) {
    const before = graduatedRaw ? (JSON.parse(graduatedRaw) as { _comment?: string; rows?: ResearchRow[] }) : {};
    const rows = mergeResearch(before.rows ?? [], rest);
    writes.set(GRADUATED_FILE_NAME, `${JSON.stringify({ _comment: before._comment ?? GRADUATED_COMMENT, rows }, null, 2)}\n`);
  }
  return { writes, inPlace, toGraduated: rest.length };
}
