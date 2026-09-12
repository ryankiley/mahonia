// Research-level checks — the ones that need the CITED source (weight_value +
// unit, the verbatim quote, kcal_quote), which the built CSV no longer carries.
// Extracted from audit-catalog.ts so the same checks run in TWO places:
//   • `npm run catalog:audit` (and the prod reseed workflow, which aborts on errors)
//   • tests/catalog-research.test.ts, so `npm test` — and therefore CI on every
//     PR — fails on them too. A convention that only a hand-run script enforces
//     is a convention that drifts; this is what makes them hold.
//
// ERRORS gate the build. WARNINGS (weight-range plausibility) are for a human.
// Pure and fs-free: the caller reads the files (scripts/research.ts) and passes them in.

import { ATTRIBUTE_KEYS, validateAttributes } from "./catalogAttributes";
import type { Finding } from "./catalogChecks";
import { gearLabel } from "./catalogChecks";
import { identityKey, isCitationUrl, isWeightSource, specToMg, type SpecUnit } from "./catalogCsv";
import type { ResearchFile } from "./research";
import { RANGE_G } from "../shared/catalogQuality";

/** All gram-equivalent figures mentioned in a quote (kg converted to g).
 *  Handles thousands separators ("1,790 g" is 1790, not 790). */
export function gramsInQuote(q: string): number[] {
  const out: number[] = [];
  const num = (s: string) => parseFloat(s.replace(/,/g, ""));
  for (const m of q.matchAll(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*kg/gi)) out.push(num(m[1]) * 1000);
  for (const m of q.matchAll(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*g(?![a-z])/gi)) out.push(num(m[1]));
  return out;
}

const WORD_NUMBER: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };

/** How many servings a food row is. Read, in order: "2 servings" in the variant;
 *  "Servings per container: 2.5" or "contains 2, 25g servings" in the kcal quote; a
 *  container count divided by the serving size ("bottle of 60" ÷ "Serving Size 2
 *  tablets" = 30). Defaults to 1. */
export function servingsOf(variant: string | null | undefined, kcalQuote: string | null | undefined): number {
  const v = variant ?? "";
  const q = kcalQuote ?? "";
  const fromVariant = v.match(/\b(\d+(?:\.\d+)?)\s+servings?\b/i);
  if (fromVariant) return Number(fromVariant[1]);
  const perContainer = q.match(/servings?\s+per\s+(?:container|pouch|package|bottle|bag)\s*[:\-–]?\s*(\d+(?:\.\d+)?)/i);
  if (perContainer) return Number(perContainer[1]);
  const contains = q.match(/contains\s+(\d+)\b[^.]{0,20}?servings?/i);
  if (contains) return Number(contains[1]);
  const inline = q.match(/\b(\d+(?:\.\d+)?|one|two|three|four)\s+servings?\b/i);
  if (inline) return WORD_NUMBER[inline[1].toLowerCase()] ?? Number(inline[1]);
  const count = v.match(/\b(?:of|bottle of|bag of|package of|sleeve of)\s*(\d+)\b/i) ?? v.match(/\b(\d+)[- ]?(?:ct|count|pack)\b/i);
  const perServing = q.match(/serving size[:\s]*(\d+)\s+(?:tablets?|pieces?|chews?|bars?|pastries|wafers?|cookies?|packets?)/i);
  if (count && perServing && Number(count[1]) % Number(perServing[1]) === 0) return Number(count[1]) / Number(perServing[1]);
  return 1;
}

/** Does the kcal figure follow from its own quote? True when kcal equals a number in
 *  the quote, or a number in the quote times the row's serving count (a panel gives
 *  per-serving calories; the row stores the whole pouch). */
export function kcalMatchesQuote(kcal: number, kcalQuote: string, servings: number): boolean {
  const nums = [...kcalQuote.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)].map((m) => Number(m[1].replace(/,/g, "")));
  return nums.some((n) => n === kcal || n * servings === kcal);
}

// Pouch meals are the food rows where "net vs as-carried" moves the number by
// 20–30 g. Bars and chews are exempt (a wrapper is a gram or two).
const POUCH_MEAL = /^meal$/i;
const AS_CARRIED_EVIDENCE = /total weight|package weight|packaged weight|pouch included|as carried|weighed/i;

export function runResearchChecks(files: ResearchFile[]): Finding[] {
  const out: Finding[] = [];
  const err = (code: string, message: string) => out.push({ level: "error", code, message });
  const warn = (code: string, message: string) => out.push({ level: "warning", code, message });
  const identity = new Map<string, { g: number; where: string }>();

  for (const { file, rows, parseError } of files) {
    if (parseError) {
      err("json", `${file}: ${parseError}`);
      continue;
    }
    for (const r of rows) {
      const where = `${file}: ${gearLabel(r)}`;

      // hygiene: provenance enum + a real citation URL
      if (!isWeightSource(r.weight_source ?? "")) err("source", `${where}: weight_source="${r.weight_source}"`);
      const url = (r.source_url ?? "").trim();
      if (!isCitationUrl(url)) err("url", `${where}: bad source_url "${url}"`);

      // ATTRIBUTES — typed axes, each in one canonical form. A wrong key, a "20°F", a
      // fill power as a string: all errors here; the CSV check then holds what IS
      // stated to the variant text (a "20F" variant must carry temp_f 20).
      for (const p of validateAttributes(r.attributes)) err("attr", `${where}: ${p}`);
      // a researched attribute cited to another page carries a URL and a quote together
      const aUrl = (r.attributes_source_url ?? "").trim();
      const aQuote = (r.attributes_quote ?? "").trim();
      if (aUrl || aQuote) {
        if (!isCitationUrl(aUrl) || !aQuote) err("attr-cite", `${where}: attributes_source_url and attributes_quote go together (a real URL plus a verbatim quote)`);
        if (!r.attributes || !Object.keys(r.attributes).length) err("attr-cite", `${where}: an attributes citation with no attributes`);
      }
      // an axis recorded as unpublished is a real key, and not one the row also states
      if (r.attributes_unpublished != null) {
        if (!Array.isArray(r.attributes_unpublished) || !r.attributes_unpublished.length) err("attr-unpublished", `${where}: attributes_unpublished must be a non-empty list of axes`);
        else {
          for (const k of r.attributes_unpublished) {
            if (!(ATTRIBUTE_KEYS as readonly string[]).includes(k)) err("attr-unpublished", `${where}: "${k}" is not an axis (one of ${ATTRIBUTE_KEYS.join(", ")})`);
            else if (r.attributes && (r.attributes as Record<string, unknown>)[k] != null) err("attr-unpublished", `${where}: ${k} is both stated in attributes and listed as unpublished`);
          }
        }
      }

      // the cited weight must convert
      let mg: number;
      try {
        mg = specToMg(Number(r.weight_value), r.weight_unit as SpecUnit, r.weight_secondary);
      } catch (e) {
        err("convert", `${where}: ${(e as Error).message}`);
        continue;
      }
      const g = mg / 1000;

      // plausibility (a human's list — heavy boots and per-pair poles are legit)
      const range = RANGE_G[r.category_hint ?? "other"] ?? RANGE_G.other;
      if (g < range[0] || g > range[1]) {
        warn("range", `${where}: ${g.toFixed(0)} g outside ${r.category_hint} range ${range[0]}–${range[1]} g | ${r.weight_value}${r.weight_unit}`);
      }

      // QUOTE CROSS-CHECK against the gram figure CLOSEST to the computed value, so
      // a legit secondary figure (packed weight, another size) doesn't false-positive
      // while a real transcription error (no nearby figure) still trips.
      const grams = gramsInQuote(r.quote ?? "");
      if (grams.length) {
        const nearest = grams.reduce((a, b) => (Math.abs(b - g) < Math.abs(a - g) ? b : a));
        const diff = Math.abs(g - nearest);
        if (diff > Math.max(8, 0.05 * nearest)) {
          err("quote", `${where}: computed ${g.toFixed(0)} g, nearest quote figure ${nearest} g (Δ${diff.toFixed(0)} g) | grams in quote: ${grams.join(", ")} | "${(r.quote ?? "").slice(0, 90)}"`);
        }
      }

      // the same identity cited twice with a different weight
      // The same identity cited twice: a conflicting weight is a real error; an
      // agreeing copy is dead research the build silently drops (kept-first), and
      // the copy that ships may not be the one someone later edits — an error too.
      const key = identityKey(r.brand ?? "", r.name ?? "", r.variant ?? "");
      const prev = identity.get(key);
      if (prev) {
        if (Math.abs(prev.g - g) > Math.max(8, 0.02 * g)) err("dup", `${where}: ${g.toFixed(0)} g conflicts with ${prev.g.toFixed(0)} g from ${prev.where}`);
        else err("dup-row", `${where}: same identity already cited in ${prev.where} — delete one`);
      } else {
        identity.set(key, { g, where });
      }

      // KCAL CROSS-CHECK — the calorie figure is held to the same bar as the weight:
      // it has to be readable out of its own quote (per pouch, or per serving × servings).
      if (r.kcal != null) {
        const kq = (r.kcal_quote ?? "").trim();
        if (kq && !kcalMatchesQuote(Number(r.kcal), kq, servingsOf(r.variant, kq))) {
          err("kcal-quote", `${where}: kcal ${r.kcal} is not in its quote (nor a per-serving figure × ${servingsOf(r.variant, kq)} servings) | "${kq.slice(0, 90)}"`);
        }
      }

      // FOOD WEIGHT BASIS — a pouch meal stores what you carry (pouch included) or
      // says "net". Either the quote shows a packaged/weighed figure, or the variant
      // carries "net"; a row that does neither is ambiguous about 20–30 g.
      const isPouchMeal = (r.category_hint ?? "").toLowerCase() === "consumable" && POUCH_MEAL.test((r.common_name ?? "").trim());
      if (isPouchMeal) {
        const saysNet = (r.variant ?? "").split(/,\s*/).includes("net");
        const evidence = AS_CARRIED_EVIDENCE.test(r.quote ?? "");
        if (!saysNet && !evidence) {
          err("food-weight-basis", `${where}: a pouch meal must either cite a packaged/weighed figure ("total weight", "pouch included", "weighed") or say "net" in its variant`);
        }
        if (saysNet && evidence) {
          err("food-weight-basis", `${where}: the quote shows an as-carried figure — store it and drop "net"`);
        }
      }
    }
  }
  return out;
}
