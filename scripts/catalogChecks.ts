// Standing data-quality checks for the catalog — the defect classes we kept
// hand-cleaning, turned into deterministic checks so they fail CI instead of
// surviving to an ad-hoc spot-check later.
//
// ERRORS gate the build (npm test fails). WARNINGS are heuristic — surfaced by
// `npm run catalog:audit` for a human to eyeball, but don't fail the build.
//
// Pure + dependency-light on purpose (no DB import) so the gating test stays fast.

import type { CatalogCsvRow } from "./catalogCsv";
import { isVariantRedundant, normalizeVariant, normKey, RANGE_G } from "../shared/catalogQuality";
import { GEAR_TYPE_ALIASES } from "./gearTypes";

export interface Finding {
  level: "error" | "warning";
  code: string;
  message: string;
}

// Prose that should never appear in a variant (variant = clean size/config only).
const VARIANT_COMMENTARY =
  /\b(not specified|current catalog|current live|no medium|base config|sku page|lot average|closest config|page does not|removable cape|spec scales|weight not published|measured weight per|starting weight|manufacturer spec size|only size offered|sold in a|sold individually)\b|colou?rway|outdoorgearlab|\bvia [a-z]|scale\)/i;

// Colour words that are weight-irrelevant and shouldn't fragment identity.
// (Checked on VARIANT only — product names like "Silver Shadow" live in `name`.)
const COLOUR_ATTR =
  /\b(black|white|grey|gray|blue|navy|red|green|olive|khaki|tan|charcoal|sage|orange|yellow|purple|pink|brown|silver|graphite|slate|teal|maroon|burgundy|cream|beige|ivory|coyote|avalanche|habitat)\b/i;

// Pole-family items (trekking poles + their baskets/paws) — the ONE class of
// paired gear that keeps a "per pair" unit label, since single-pole use is a real
// setup. Used to exempt them from the "drop per pair" rule below.
const POLE_ITEM = /\b(pole|poles|paw|paws|basket|baskets)\b/i;

// Review/blog hosts — fine as a "measured" source, but a row claiming
// weight_source="manufacturer" cited to one of these is provenance laundering.
const REVIEW_DOMAINS = [
  "outdoorgearlab.com", "cleverhiker.com", "switchbacktravel.com", "sectionhiker.com",
  "thetrek.co", "treelinereview.com", "pieonthetrail.com", "faroutguides.com",
  "advnture.com", "runrepeat.com", "believeintherun.com", "gearjunkie.com",
  "theinertia.com", "backwoodspursuit.com", "roadsriversandtrails.com", "bettertrail.com",
  "halfwayanywhere.com", "thebigoutside.com", "weightofthing.com", "the-high-route.com",
];

/** One label for a row in a message: "Brand Name [Variant]". Shared with the
 *  audit CLI so a row is named the same way wherever it's reported. */
export const gearLabel = (r: { brand?: string | null; name?: string | null; variant?: string | null }) =>
  `${r.brand ?? ""} ${r.name ?? "?"}${r.variant ? ` [${r.variant}]` : ""}`.trim();

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** True iff `short` appears in `long` as a CONTIGUOUS run of WHOLE tokens.
 *  Word-level, not string-level: "light quilt" is NOT contained in "ultralight
 *  quilt" (the glued `ultra|light` prefix), so distinct product lines that merely
 *  share a weight don't read as one name containing the other. */
function tokenRunIncludes(long: string[], short: string[]): boolean {
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((t, j) => long[i + j] === t)) return true;
  }
  return false;
}

/** Run all standing checks over the parsed catalog rows. */
export function runCatalogChecks(rows: CatalogCsvRow[]): Finding[] {
  const out: Finding[] = [];
  const err = (code: string, message: string) => out.push({ level: "error", code, message });
  const warn = (code: string, message: string) => out.push({ level: "warning", code, message });

  // --- ERROR: a row shipped without a gear type ------------------------------
  // It's the label a pick pre-fills onto the user's item, so a blank one silently
  // costs every future list that adds this row. build-catalog.ts already fails the
  // build on it; this makes the committed CSV answer for it too.
  for (const r of rows) {
    if (!r.commonName?.trim()) err("common-name-missing", `${gearLabel(r)}: no gear type`);
  }

  // --- ERROR: a gear type that the drift map should have collapsed -----------
  // A label that is still an ALIAS key never went through normalizeGearType (or was
  // hand-edited into the CSV afterwards), so the vocabulary has two words for one thing.
  for (const r of rows) {
    const canon = r.commonName && GEAR_TYPE_ALIASES[r.commonName.trim().toLowerCase()];
    if (canon) err("common-name-drift", `${gearLabel(r)}: gear type "${r.commonName}" → canonical "${canon}"`);
  }

  // --- ERROR: variant carries research commentary instead of a clean config ---
  // Keyword-driven (deterministic, low false-positive). A legit size spec like
  // "(US size 9 / M9)" or "(tapered)" must NOT trip — only prose markers do.
  for (const r of rows) {
    const v = r.variant ?? "";
    if (v && VARIANT_COMMENTARY.test(v)) {
      err("variant-commentary", `${gearLabel(r)}: variant reads like a note, not a config: "${v}"`);
    }
  }

  // --- ERROR: same product + same weight = redundant duplicate row ----------
  // (Same brand+name, equal weight, and one variant is a subset/empty of the
  // other — i.e. not two genuinely-different size variants that happen to match.)
  // "Same weight" is exact between two NAMED variants (a men's and a women's
  // pack, a GPS and a GPS + Cellular watch legitimately land within a gram of
  // each other), but allows a 1% spread when one variant is EMPTY: that's the
  // same product cited from two pages (the maker's "2 oz / 0.06 kg" and a
  // stockist's "57 g"), and exact equality let a "Z Seat" / "Z-Seat" pair ship.
  const byProduct = new Map<string, CatalogCsvRow[]>();
  for (const r of rows) {
    const k = `${normKey(r.brand)}|${normKey(r.name)}`;
    (byProduct.get(k) ?? byProduct.set(k, []).get(k)!).push(r);
  }
  for (const group of byProduct.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const wa = group[a].weightMg;
        const wb = group[b].weightMg;
        const va = normKey(group[a].variant);
        const vb = normKey(group[b].variant);
        const oneBlank = va === "" || vb === "";
        const sameWeight = oneBlank ? Math.abs(wa - wb) <= 0.01 * Math.max(wa, wb) : wa === wb;
        if (!sameWeight) continue;
        const subset = oneBlank || va.includes(vb) || vb.includes(va) || va === vb;
        if (subset) {
          err(
            "duplicate-row",
            `${group[a].brand} ${group[a].name}: same weight (${wa} mg vs ${wb} mg) for variants "${group[a].variant ?? ""}" and "${group[b].variant ?? ""}" — likely the same product twice`,
          );
        }
      }
    }
  }

  // --- ERROR: same product under two NAMES (same brand + weight, one name is
  // a substring of the other, e.g. "Classic SD" vs "Classic SD Swiss Army
  // Knife"). Complements the same-name/same-weight check above. ---------------
  const byBrand = new Map<string, CatalogCsvRow[]>();
  for (const r of rows) {
    const k = normKey(r.brand);
    (byBrand.get(k) ?? byBrand.set(k, []).get(k)!).push(r);
  }
  for (const group of byBrand.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        if (group[a].weightMg !== group[b].weightMg) continue;
        const ta = normKey(group[a].name).split(" ").filter(Boolean);
        const tb = normKey(group[b].name).split(" ").filter(Boolean);
        if (ta.join(" ") === tb.join(" ")) continue; // same-name case handled above
        const [sh, lo] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
        if (sh.join("").length < 4 || !tokenRunIncludes(lo, sh)) continue;
        // The extra tokens in the longer name decide it: if they're all
        // generation/line markers (a number, "classic", "pro", "+", …) the two
        // are DISTINCT products that merely share a weight (inReach Mini vs
        // Mini 2; Plex Solo vs Plex Solo Classic) — not a dup. Only flag when the
        // extra tokens are generic descriptors ("swiss army knife", "water filter").
        const extra = lo.filter((t) => !sh.includes(t));
        const VERSION = /^(\d+\+?|classic|pro|lite|ul|sl|lt|hv|nxt|elite|max|plus|air|se|x|mini|micro)$/;
        if (extra.length > 0 && extra.every((t) => VERSION.test(t))) continue;
        err(
          "duplicate-name",
          `${group[a].brand}: "${group[a].name}" and "${group[b].name}" — same weight (${group[a].weightMg} mg), one name contains the other; likely the same product`,
        );
      }
    }
  }

  // --- ERROR: case-only identity collision (e.g. "NEMO" vs "Nemo") ----------
  const byCI = new Map<string, CatalogCsvRow>();
  for (const r of rows) {
    const ciNorm = (x: string | null) => (x || "").toLowerCase().replace(/\s+/g, " ").trim();
    // preserve punctuation so "Lone Peak 9" vs "Lone Peak 9+" stay distinct
    const ci = ciNorm(r.brand) + "|" + ciNorm(r.name) + "|" + ciNorm(r.variant);
    const exact = `${r.brand ?? ""}\u0000${r.name}\u0000${r.variant ?? ""}`;
    const prev = byCI.get(ci);
    if (prev) {
      const prevExact = `${prev.brand ?? ""}\u0000${prev.name}\u0000${prev.variant ?? ""}`;
      if (prevExact !== exact) {
        err("case-collision", `${gearLabel(r)} collides case-insensitively with ${gearLabel(prev)} (normalize casing)`);
      }
    } else {
      byCI.set(ci, r);
    }
  }

  // --- WARNING: provenance laundering (manufacturer claim from a review site) -
  for (const r of rows) {
    if (r.weightSource !== "manufacturer") continue;
    const host = hostOf(r.sourceUrl);
    if (host && REVIEW_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
      warn("provenance", `${gearLabel(r)}: weight_source=manufacturer but cited to a review site (${host}) — re-source or mark measured`);
    }
  }

  // --- WARNING: colour-as-attribute in variant ------------------------------
  for (const r of rows) {
    if (r.variant && COLOUR_ATTR.test(r.variant)) {
      warn("colour-variant", `${gearLabel(r)}: variant contains a colour ("${r.variant}") — colour rarely affects weight`);
    }
  }

  // --- WARNING: weight outside the category's plausible range ----------------
  for (const r of rows) {
    const range = RANGE_G[r.categoryHint ?? "other"] ?? RANGE_G.other;
    const g = r.weightMg / 1000;
    if (g < range[0] || g > range[1]) {
      warn("plausibility", `${gearLabel(r)}: ${g.toFixed(1)} g outside ${r.categoryHint} range ${range[0]}–${range[1]} g`);
    }
  }

  // --- WARNING: trekking poles not on the single "per pair" convention -------
  // Poles are the ONE paired item that keeps a unit label (single-pole use is a
  // real setup). To avoid a confusing mix of per-pole and per-pair weights, the
  // catalog standardizes on "per pair" for every pole — so a bare pole, or one
  // still marked "per pole", is flagged to convert.
  // Match a name that ENDS in "trekking pole(s)" — a bare "pole" also names tent
  // poles, pole sets, and pole bags, and a "Trekking Pole Cup" / "Trekking Pole
  // Holsters" is an accessory FOR poles, not a pair of them.
  for (const r of rows) {
    if (/\btrekking\s+poles?$/i.test(r.name.trim()) && !/\bper pair\b/i.test(r.variant ?? "")) {
      warn("pole-unit", `${gearLabel(r)}: trekking poles should state "per pair" (the catalog's single pole-weight convention)`);
    }
  }

  // --- WARNING: "per pair" label on non-pole gear ---------------------------
  // House policy: worn-as-a-pair apparel (footwear, socks, gaiters, gloves, etc.)
  // is stored as a PAIR weight with NO label — nobody carries one boot, so the
  // annotation is noise. Only trekking poles (above) keep a unit. A stray
  // "per pair" on anything else is a leftover to drop.
  for (const r of rows) {
    if (/\bper pair\b/i.test(r.variant ?? "") && !POLE_ITEM.test(r.name)) {
      warn("per-pair-label", `${gearLabel(r)}: drop "per pair" — worn-pair apparel is stored as a pair weight without the label`);
    }
  }

  // --- WARNING: variant isn't in canonical form (run normalizeVariant) -------
  for (const r of rows) {
    const v = r.variant ?? "";
    if (v && normalizeVariant(v) !== v) {
      warn("variant-noncanonical", `${gearLabel(r)}: variant "${v}" → canonical "${normalizeVariant(v)}"`);
    }
  }

  // --- WARNING: variant just repeats the name (e.g. "Copper Spur HV UL3" + "UL3") -
  for (const r of rows) {
    if (r.variant && isVariantRedundant(r.name, r.variant)) {
      warn("variant-redundant", `${gearLabel(r)}: variant "${r.variant}" already in the name — clear it`);
    }
  }

  return out;
}
