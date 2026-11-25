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

import { isAttributeKey, validateAttributes } from "./catalogAttributes";
import type { Finding } from "./catalogChecks";
import { gearLabel } from "./catalogChecks";
import { identityKey, isCitationUrl, isWeightSource, specToMg } from "./catalogCsv";
import { GRADUATED_FILE_NAME, researchGearType, type ResearchFile } from "./research";
import { ATTRIBUTE_KEYS } from "../shared/catalogAxes";
import { gramsInQuote, quoteTolerance, RANGE_G, tidyQuote, weightsInQuote } from "../shared/catalogQuality";
import type { Unit } from "../shared/types";

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
  if (inline) return WORD_NUMBER[inline[1]!.toLowerCase()] ?? Number(inline[1]);
  const count = v.match(/\b(?:of|bottle of|bag of|package of|sleeve of)\s*(\d+)\b/i) ?? v.match(/\b(\d+)[- ]?(?:ct|count|pack)\b/i);
  const perServing = q.match(/serving size[:\s]*(\d+)\s+(?:tablets?|pieces?|chews?|bars?|pastries|wafers?|cookies?|packets?)/i);
  if (count && perServing && Number(count[1]) % Number(perServing[1]) === 0) return Number(count[1]) / Number(perServing[1]);
  return 1;
}

/** Does the kcal figure follow from its own quote? True when kcal equals a number in
 *  the quote, or a number in the quote times the row's serving count (a panel gives
 *  per-serving calories; the row stores the whole pouch). */
export function kcalMatchesQuote(kcal: number, kcalQuote: string, servings: number): boolean {
  const nums = [...kcalQuote.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
  return nums.some((n) => n === kcal || n * servings === kcal);
}

// Pouch meals are the food rows where "net vs as-carried" moves the number by
// 20–30 g. Bars and chews are exempt (a wrapper is a gram or two).
const POUCH_MEAL = /^meal$/i;
const AS_CARRIED_EVIDENCE = /total weight|package weight|packaged weight|pouch included|as carried|weighed/i;

// Tents are the shelter rows where a maker prints two figures 100–300 g apart: the
// "trail" or "minimum" weight (fly, inner, poles) and the "packed" / "packaged" / "total"
// / "typical" weight (everything in the box: stakes, guylines, bags). The catalog stores
// the PACKAGED figure, the food rule's "what you carry" applied to shelter (decided
// 2026-09-12). A row that could only be sourced at trail weight says "trail weight" in
// its variant, and the audit lists it as a to-do.
const TRAIL_WEIGHT = /\b(?:min(?:imum)?\.?\s*(?:\(?trail\)?\s*)?weight|trail\s*weight|fly\s*\+\s*inner|fly and inner|without stakes|no stakes)\b/i;
const PACKED_WEIGHT = /\b(?:pack(?:ed|aged)?\s*weight|package\s*weight|total\s*weight|typical\s*weight|full\s*weight|with stakes|including (?:all )?stakes|all[- ]in)\b/i;
const TRAIL_TOKEN = "trail weight";
// A retailer that labels the figure after it: "19oz | 539g (trail)", "688g (minimum)".
const TRAIL_SUFFIX = /(\d+(?:\.\d+)?)\s*(g|kg|oz)\s*\((?:trail|min(?:imum)?)\)/i;

/** The first gram-equivalent figure after `re` in `q`, or null. */
function figureAfter(q: string, re: RegExp): number | null {
  const i = q.search(re);
  if (i < 0) return null;
  const m = q.slice(i).match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(g|kg|oz|lbs?)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]!.replace(/,/g, ""));
  const u = m[2]!.toLowerCase();
  let g = u === "g" ? n : u === "kg" ? n * 1000 : u === "oz" ? n * 28.3495 : n * 453.592;
  // "3 lb 5 oz": add a trailing ounce remainder
  if (u.startsWith("lb")) {
    const rest = q.slice(i + m.index! + m[0].length).match(/^[.,]?\s*,?\s*(\d+(?:\.\d+)?)\s*oz\b/i);
    if (rest) g += parseFloat(rest[1]!) * 28.3495;
  }
  return g;
}
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(8, 0.03 * b);

// Belted packs are the other gear where a maker prints a figure lighter than what ships:
// a "minimum" / "stripped" / "base" weight, or the pack without its belt. The catalog
// stores the pack AS IT SHIPS, every part in the box (hip belt, frame or stays, back pad,
// removable lid), the tent rule applied to packs (decided 2026-11-25). A part the maker
// sells separately stays out. A pack whose belt is optional, or sold both ways, says
// "no hipbelt" / "with hipbelt"; a row that could only be sourced at a stripped figure
// says "minimum" in its variant, and the audit lists it as a to-do.
const BELTED_PACK = /^(?:back|day|fast)pack$/i;
const PACK_MINIMUM = /\b(?:min(?:imum)?\.?(?:\s+usable)?\s*weight|stripped\s*weight|base\s*weight|no\s*(?:hip\s*)?belt|without\s*(?:the\s*)?(?:hip\s*)?belt)\b|\(minimum\)/i;
const PACK_FULL = /\b(?:fully\s*equipped|total\s*weight|total\s+with|packed\s*weight|max(?:imum)?\s*weight|with\s*(?:the\s*)?(?:hip\s*)?belt)\b/i;
const PACK_MIN_TOKEN = "minimum";
const PACK_NO_BELT_TOKEN = "no hipbelt";

/** The figure a label in `q` names: the one right after it ("Minimum Weight: 1340 g"),
 *  else the one right before it ("780g (Minimum Weight)", "1390g without hip belt"),
 *  else the first one after it. A maker writes both orders, often on one page. */
function figureBy(q: string, re: RegExp): number | null {
  const m = re.exec(q);
  if (!m) return null;
  if (/^\s*[:=]?\s*\(?\d/.test(q.slice(m.index + m[0].length))) return figureAfter(q, re);
  const before = q.slice(Math.max(0, m.index - 24), m.index).match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(g|kg|oz|lbs?)\)?\s*\(?\s*$/i);
  if (!before) return figureAfter(q, re);
  const n = parseFloat(before[1]!.replace(/,/g, ""));
  const u = before[2]!.toLowerCase();
  return u === "g" ? n : u === "kg" ? n * 1000 : u === "oz" ? n * 28.3495 : n * 453.592;
}

export function runResearchChecks(files: ResearchFile[], commonNames: Map<string, string> = new Map()): Finding[] {
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

      // hygiene: a quote is the page's words as a reader sees them — one line, single
      // spaces, no markup or entities left over from reading the HTML (tidyQuote)
      for (const field of ["quote", "kcal_quote", "attributes_quote"] as const) {
        const q = r[field];
        if (typeof q !== "string") continue;
        if (/<\/?[a-z][^>]*>|&(?:[a-z]+|#\d+);/i.test(q)) err("quote-hygiene", `${where}: ${field} carries HTML — quote the text a reader sees`);
        else if (q !== tidyQuote(q)) err("quote-hygiene", `${where}: ${field} has odd or doubled spaces or line breaks — one line, single spaces`);
      }

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
            if (!isAttributeKey(k)) err("attr-unpublished", `${where}: "${k}" is not an axis (one of ${ATTRIBUTE_KEYS.join(", ")})`);
            else if (r.attributes && (r.attributes as Record<string, unknown>)[k] != null) err("attr-unpublished", `${where}: ${k} is both stated in attributes and listed as unpublished`);
          }
        }
      }

      // the cited weight must convert
      let mg: number;
      try {
        mg = specToMg(Number(r.weight_value), r.weight_unit as Unit, r.weight_secondary);
      } catch (e) {
        err("convert", `${where}: ${(e as Error).message}`);
        continue;
      }
      const g = mg / 1000;

      // plausibility (a human's list — heavy boots and per-pair poles are legit)
      const range = RANGE_G[r.category_hint ?? "other"] ?? RANGE_G.other!;
      if (g < range[0] || g > range[1]) {
        warn("range", `${where}: ${g.toFixed(0)} g outside ${r.category_hint} range ${range[0]}–${range[1]} g | ${r.weight_value}${r.weight_unit}`);
      }

      // QUOTE CROSS-CHECK against the gram figure CLOSEST to the computed value, so
      // a legit secondary figure (packed weight, another size) doesn't false-positive
      // while a real transcription error (no nearby figure) still trips. A row graduated
      // from the app is read as verify_catalog_item read it, ounces and pounds too, so it
      // is held to the rule it was taken on. The hand research keeps the metric read:
      // its ounce-only quotes include lists and ranges ("13/19 oz", "36 to 39 oz") that
      // a single-figure read would flag.
      const grams = (file === GRADUATED_FILE_NAME ? weightsInQuote : gramsInQuote)(r.quote ?? "");
      if (grams.length) {
        const nearest = grams.reduce((a, b) => (Math.abs(b - g) < Math.abs(a - g) ? b : a));
        const diff = Math.abs(g - nearest);
        if (diff > quoteTolerance(nearest)) {
          err("quote", `${where}: computed ${g.toFixed(0)} g, nearest quote figure ${nearest.toFixed(0)} g (Δ${diff.toFixed(0)} g) | grams in quote: ${grams.map((n) => n.toFixed(0)).join(", ")} | "${(r.quote ?? "").slice(0, 90)}"`);
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
      const gearType = researchGearType(r, commonNames);
      const isPouchMeal = (r.category_hint ?? "").toLowerCase() === "consumable" && POUCH_MEAL.test(gearType);
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

      // TENT WEIGHT BASIS — a tent row stores the packaged weight (everything in the box).
      // Read from the quote: the figure after a "trail"/"minimum" label and the figure
      // after a "packed"/"total"/"typical" label. Storing the trail figure when the packed
      // one is on the page is an error; a row that could only be sourced at trail weight
      // says "trail weight" in its variant and is listed as a to-do.
      if (/^tent$/i.test(gearType)) {
        const q = r.quote ?? "";
        const saysTrail = (r.variant ?? "").split(/,\s*/).includes(TRAIL_TOKEN);
        const trail = figureAfter(q, TRAIL_WEIGHT);
        const packed = figureAfter(q, PACKED_WEIGHT);
        // the stored figure is the trail one when it matches the figure after a trail label,
        // or when the quote calls its only figure a minimum weight and gives no packed one
        const suffix = TRAIL_SUFFIX.exec(q);
        const labelledAfter = suffix
          ? parseFloat(suffix[1]!) * (suffix[2]!.toLowerCase() === "kg" ? 1000 : suffix[2]!.toLowerCase() === "oz" ? 28.3495 : 1)
          : null;
        const storedIsTrail = (trail != null
          ? near(g, trail) && !(packed != null && near(g, packed))
          : packed == null && TRAIL_WEIGHT.test(q))
          || (labelledAfter != null && near(g, labelledAfter) && !(packed != null && near(g, packed)));
        if (saysTrail) {
          if (packed != null) err("tent-weight-basis", `${where}: the quote shows a packaged figure (${packed.toFixed(0)} g) — store it and drop "trail weight"`);
          else warn("tent-trail-weight", `${where}: stored at trail weight — find the packaged weight (maker "packed" / "total" / "typical" weight) and drop "trail weight"`);
        } else if (storedIsTrail) {
          err("tent-weight-basis", packed != null
            ? `${where}: ${g.toFixed(0)} g is the trail/minimum weight; the packaged weight on the same page is ${packed.toFixed(0)} g — store that`
            : `${where}: ${g.toFixed(0)} g is the trail/minimum weight — find the packaged weight, or say "trail weight" in the variant`);
        }
      }

      // PACK WEIGHT BASIS — a belted pack stores the pack as it ships. Read from the quote
      // as the tent rule is: the figure a "minimum"/"stripped"/"base"/"no belt" label names
      // and the one a "total"/"fully equipped"/"with hip belt" label names. Storing the
      // minimum when the full figure is on the page is an error; so is storing it unlabelled.
      if (BELTED_PACK.test(gearType)) {
        const q = r.quote ?? "";
        const tokens = (r.variant ?? "").split(/,\s*/);
        const saysMin = tokens.includes(PACK_MIN_TOKEN);
        const min = figureBy(q, PACK_MINIMUM);
        const full = figureBy(q, PACK_FULL);
        const storedIsMin = min != null ? near(g, min) && !(full != null && near(g, full)) : full == null && PACK_MINIMUM.test(q);
        if (saysMin) {
          if (full != null) err("pack-weight-basis", `${where}: the quote shows the full pack (${full.toFixed(0)} g) — store it and drop "minimum"`);
          else warn("pack-minimum-weight", `${where}: stored at a minimum weight — find the weight as it ships (hip belt, frame and lid included) and drop "minimum"`);
        } else if (storedIsMin && !tokens.includes(PACK_NO_BELT_TOKEN)) {
          err("pack-weight-basis", full != null
            ? `${where}: ${g.toFixed(0)} g is the pack's minimum; the full weight on the same page is ${full.toFixed(0)} g — store that`
            : `${where}: ${g.toFixed(0)} g is the pack's minimum — find the weight as it ships, or say "minimum" (or "no hipbelt", when the belt is optional) in the variant`);
        }
      }
    }
  }
  return out;
}
