// Standing data-quality checks for the catalog — the defect classes we kept
// hand-cleaning, turned into deterministic checks so they fail CI instead of
// surviving to an ad-hoc spot-check later.
//
// ERRORS gate the build (npm test fails, and CI runs npm test on every PR). Every
// CONVENTION is an error: a rule that only warns is a rule that drifts. The two
// WARNINGS left are not conventions but judgment lists for a human — weight
// plausibility (heavy boots and sub-gram patches are legit) and pouch meals still
// at net weight (a to-do until someone weighs one). Research-level checks (the
// cited quote vs the stored weight, kcal vs its panel) live in researchChecks.ts.
//
// Pure + dependency-light on purpose (no DB import) so the gating test stays fast.

import type { CatalogCsvRow } from "./catalogCsv";
import { isVariantRedundant, normalizeVariant, normKey, RANGE_G } from "../shared/catalogQuality";
import { soldByOf, traitsOf, type AttributeKey } from "../shared/catalogAxes";
import { extractAttributes, SHOE_REGIONS } from "./catalogAttributes";
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

  // --- ERROR: the name starts with its own brand ------------------------------
  // The UI renders brand + name joined ("Apple" + "Apple Watch SE 3" → "Apple Apple
  // Watch SE 3"), so the brand lives in `brand` only. A collab is a brand of its own
  // ("Zpacks x Vaucluse"), and an eponymous product takes a descriptor for a name.
  for (const r of rows) {
    const b = (r.brand ?? "").trim();
    if (b && new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(r.name.trim())) {
      err("name-repeats-brand", `${gearLabel(r)}: name starts with the brand — drop it from the name (or make the collab the brand)`);
    }
  }

  // --- ERROR: a qualifier hiding in the name ----------------------------------
  // " - Regular", "(low)", "(2024)", "(SP129)" are configs, not names: they go in
  // `variant`. Parentheses are allowed on food rows (the flavor convention:
  // "Energy Bar (Chocolate Chip)").
  for (const r of rows) {
    if (/\s[-–]\s/.test(r.name)) err("name-qualifier", `${gearLabel(r)}: " - " suffix in the name belongs in the variant`);
    else if (/\(/.test(r.name) && r.categoryHint !== "consumable") {
      err("name-qualifier", `${gearLabel(r)}: parenthetical in the name belongs in the variant (parens are for a food row's flavor)`);
    }
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

  // --- ERROR: one product modelled two ways — the size in the NAME on one row
  // ("Copper Spur HV UL2", no variant) and in the VARIANT on another ("Copper Spur
  // HV UL" + "UL2"). They render the same words, land in one dropdown twice, and
  // drift apart by a rounding step. Weight-independent on purpose: the two Copper
  // Spur rows differed by 29 mg, which the same-weight checks above let through. --
  for (const group of byBrand.values()) {
    const byName = new Map<string, CatalogCsvRow>();
    for (const r of group) byName.set(normKey(r.name), r);
    for (const r of group) {
      if (!r.variant) continue;
      // "Name Variant", and the other spelling the Copper Spur rows actually took:
      // a variant that extends the name's last word ("…HV UL" + "UL2" → "…HV UL2")
      const words = r.name.trim().split(/\s+/);
      const last = words[words.length - 1] ?? "";
      const grown = last && r.variant.toLowerCase().startsWith(last.toLowerCase()) ? [...words.slice(0, -1), r.variant].join(" ") : null;
      const twin = byName.get(normKey(`${r.name} ${r.variant}`)) ?? (grown ? byName.get(normKey(grown)) : undefined);
      if (twin && twin !== r) {
        err(
          "split-convention",
          `${r.brand}: "${r.name}" + variant "${r.variant}" and "${twin.name}" are one product modelled two ways — keep one convention`,
        );
      }
    }
  }

  // --- ERROR: one brand spelled two ways ("FLEXTAIL" / "Flextail") -------------
  // Search groups by brand text, and a hiker reads it on every row; one spelling.
  const brandSpellings = new Map<string, Set<string>>();
  for (const r of rows) {
    const b = (r.brand ?? "").trim();
    if (!b) continue;
    (brandSpellings.get(normKey(b)) ?? brandSpellings.set(normKey(b), new Set()).get(normKey(b))!).add(b);
  }
  for (const spellings of brandSpellings.values()) {
    if (spellings.size > 1) err("brand-case-split", `one brand, ${spellings.size} spellings: ${[...spellings].map((s) => `"${s}"`).join(" / ")} — pick one`);
  }

  // --- ERROR: one variant token spelled two ways ("Standard" / "standard") ------
  const tokenSpellings = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const d of (r.variant ?? "").split(/,\s*/)) {
      if (!d) continue;
      (tokenSpellings.get(d.toLowerCase()) ?? tokenSpellings.set(d.toLowerCase(), new Set()).get(d.toLowerCase())!).add(d);
    }
  }
  for (const spellings of tokenSpellings.values()) {
    if (spellings.size > 1) err("variant-case-split", `one variant token, ${spellings.size} spellings: ${[...spellings].map((s) => `"${s}"`).join(" / ")} — pick one`);
  }

  // --- ERROR: a size word leading the name ("Large Food Bag") -------------------
  // A size-named family is ONE product with size variants: "Food Bag" [L].
  for (const r of rows) {
    if (/^(?:X-Small|Small|Small-Plus|Medium|Medium-Plus|Large|X-Large|XX-Large)\b/i.test(r.name.trim())) {
      err("name-size-prefix", `${gearLabel(r)}: the size belongs in the variant — one name for the family, a letter per size`);
    }
  }

  // --- ERROR: a product-family name in the plural ("Stuff Sacks" [M]) -----------
  // Each row is one item, so the name is singular. Inherent pairs and multiples
  // (Socks, Poles, Tablets, Wipes, Straps) are not in this list on purpose.
  // It fires only when the variant is a SIZE — a "3-pack" of bags or sheets of
  // "Patches" [Camping] are legitimately plural.
  const FAMILY_PLURAL = /\b(Bags|Sacks|Pouches|Bottles|Jars|Cubes|Caps|Bands|Stakes|Pegs|Patches|Tubes|Hangers|Sprayers|Pods)$/;
  const SIZE_LIKE = /^(?:XXS|XS|S|M|L|XL|XXL|S\+|M\+|Mini|Jumbo|Regular|Long|[\d.]+\s?(?:L|ml|oz|in|mm|cm|ft|g))$/i;
  for (const r of rows) {
    const sized = (r.variant ?? "").split(/,\s*/).some((d) => SIZE_LIKE.test(d));
    if (FAMILY_PLURAL.test(r.name.trim()) && sized) {
      err("name-plural-family", `${gearLabel(r)}: a family name is singular — "${r.name.trim().replace(/(ie)s$/, "y").replace(/(ch|sh|x|s)es$/, "$1").replace(/s$/, "")}" with a size in the variant`);
    }
  }

  // --- ERROR: a row filed where none of its gear type's siblings are ------------
  // category_hint drives sort order, the plausibility band, and the consumable
  // flag; a running cap in `other` beside 17 caps in `clothing` is a misfile. Only
  // fires when the gear type has a clear home: at least 5 rows and 90% agreement.
  const catsByType = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const k = (r.commonName ?? "").toLowerCase();
    const m = catsByType.get(k) ?? catsByType.set(k, new Map()).get(k)!;
    m.set(r.categoryHint ?? "other", (m.get(r.categoryHint ?? "other") ?? 0) + 1);
  }
  for (const r of rows) {
    const m = catsByType.get((r.commonName ?? "").toLowerCase())!;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [home, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (total >= 5 && n / total >= 0.9 && (r.categoryHint ?? "other") !== home) {
      err("category-outlier", `${gearLabel(r)}: filed under ${r.categoryHint} while ${n} of ${total} "${r.commonName}" rows are ${home} — move it (or fix the gear type)`);
    }
  }

  // --- ERROR: a number and its unit split, or a prime mark, in a variant --------
  // normalizeVariant emits "6ft" / "400ml" / "5ft 6in"; a hand edit that slips past
  // it ("6 ft", '17" torso') fails here.
  for (const r of rows) {
    const v = r.variant ?? "";
    if (/\d\s+(?:ft|in|yd|cm|mm|m|km|g|kg|oz|lb|ml|qt|gal|mAh|gsm)\b/.test(v) || /["']/.test(v.replace(/\b\w+'s\b/g, ""))) {
      err("variant-unit-spacing", `${gearLabel(r)}: "${v}" — a number and its unit are one token ("6ft", "400ml"), and feet/inches are spelled out`);
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

  // --- ERROR: provenance laundering (manufacturer claim from a review site) -
  for (const r of rows) {
    if (r.weightSource !== "manufacturer") continue;
    const host = hostOf(r.sourceUrl);
    if (host && REVIEW_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
      err("provenance", `${gearLabel(r)}: weight_source=manufacturer but cited to a review site (${host}) — re-source or mark measured`);
    }
  }

  // --- ERROR: colour-as-attribute in variant ------------------------------
  for (const r of rows) {
    if (r.variant && COLOUR_ATTR.test(r.variant)) {
      err("colour-variant", `${gearLabel(r)}: variant contains a colour ("${r.variant}") — colour rarely affects weight`);
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

  // --- ERROR: trekking poles not on the single "per pair" convention -------
  // Poles are the ONE paired item that keeps a unit label (single-pole use is a
  // real setup). To avoid a confusing mix of per-pole and per-pair weights, the
  // catalog standardizes on "per pair" for every pole — so a bare pole, or one
  // still marked "per pole", is flagged to convert.
  // Match a name that ENDS in "trekking pole(s)" — a bare "pole" also names tent
  // poles, pole sets, and pole bags, and a "Trekking Pole Cup" / "Trekking Pole
  // Holsters" is an accessory FOR poles, not a pair of them.
  for (const r of rows) {
    if (/\btrekking\s+poles?$/i.test(r.name.trim()) && !/\bper pair\b/i.test(r.variant ?? "")) {
      err("pole-unit", `${gearLabel(r)}: trekking poles should state "per pair" (the catalog's single pole-weight convention)`);
    }
  }

  // --- ERROR: "per pair" label on non-pole gear ---------------------------
  // House policy: worn-as-a-pair apparel (footwear, socks, gaiters, gloves, etc.)
  // is stored as a PAIR weight with NO label — nobody carries one boot, so the
  // annotation is noise. Only trekking poles (above) keep a unit. A stray
  // "per pair" on anything else is a leftover to drop.
  for (const r of rows) {
    if (/\bper pair\b/i.test(r.variant ?? "") && !POLE_ITEM.test(r.name)) {
      err("per-pair-label", `${gearLabel(r)}: drop "per pair" — worn-pair apparel is stored as a pair weight without the label`);
    }
  }

  // --- ERROR: variant isn't in canonical form (run normalizeVariant) -------
  for (const r of rows) {
    const v = r.variant ?? "";
    if (v && normalizeVariant(v) !== v) {
      err("variant-noncanonical", `${gearLabel(r)}: variant "${v}" → canonical "${normalizeVariant(v)}"`);
    }
  }

  // --- ERROR: size written in the wrong style ---------------------------------
  // House convention (2026-09-05): S/M/L-family sizes are LETTERS — XS, S, M, L, XL —
  // on anything worn or carried, with an optional gender prefix ("Men's M"). Sleep
  // and shelter gear are exempt: there Small / Regular / Large is a LENGTH scale the
  // maker names in words beside Regular / Long, and "L" would read as a garment size.
  // Only a size word standing as the whole dimension (or right after Men's/Women's)
  // trips this, so a product size NAME like "Small Bag" passes.
  const SIZE_WORD = /^(?:(?:men's|women's)\s+)?(?:xx-small|x-small|extra small|small|medium|large|x-large|extra large|xx-large)$/i;
  for (const r of rows) {
    if (!r.variant) continue;
    const lengthScaled = r.categoryHint === "sleep" || r.categoryHint === "shelter";
    for (const dim of r.variant.split(/,\s*/)) {
      if (!lengthScaled && SIZE_WORD.test(dim)) {
        err("variant-size-style", `${gearLabel(r)}: write the size as a letter ("Medium" → "M"), not "${dim}"`);
      }
    }
  }

  // --- ERROR: footwear size with no region ----------------------------------
  // A shoe's "9" means nothing without US/UK/EU — the same shoe is a 9 US, 8 UK and
  // 42 EU. House form is "Men's US 9" / "Women's US 8" / "US 9" (unisex).
  const SHOE_REGION = new RegExp(`\\b(?:${SHOE_REGIONS})\\b`);
  for (const r of rows) {
    const v = r.variant ?? "";
    if (!traitsOf(r.commonName).footwear || !/\d/.test(v)) continue;
    if (!SHOE_REGION.test(v)) {
      err("footwear-size", `${gearLabel(r)}: footwear size "${v}" needs a region — "Men's US 9", "Women's US 8", "UK 8"`);
    }
  }

  // --- ERROR: a variant that distinguishes nothing --------------------------
  // A variant exists to tell a row apart from a sibling, or to state a size the
  // maker sells several of. So: "One size" and "Unisex" say nothing; "Standard" on
  // a product with one row is filler; "per bar" on the only row of "Energy Bar"
  // restates the name (a unit label earns its place only beside a multi-pack
  // sibling, or on trekking poles).
  const rowsPerProduct = new Map<string, number>();
  for (const r of rows) {
    const k = `${normKey(r.brand)}|${normKey(r.name)}`;
    rowsPerProduct.set(k, (rowsPerProduct.get(k) ?? 0) + 1);
  }
  // a unit label is earned when a sibling row is counted differently: "sleeve of 10"
  // beside "per tablet", or "per pair" beside "per pole"
  const hasPackSibling = (r: CatalogCsvRow) =>
    rows.some((o) => o !== r && normKey(o.brand) === normKey(r.brand) && normKey(o.name) === normKey(r.name) && /\b(\d+-pack|of \d+|per \w+)\b/i.test(o.variant ?? ""));
  for (const r of rows) {
    const v = r.variant ?? "";
    if (!v) continue;
    const single = rowsPerProduct.get(`${normKey(r.brand)}|${normKey(r.name)}`) === 1;
    const dims = v.split(/,\s*/);
    if (dims.some((d) => /^(one size|unisex|1 serving)$/i.test(d))) {
      err("variant-filler", `${gearLabel(r)}: "${v}" — "One size" / "Unisex" / "1 serving" distinguish nothing (single-serving is the unmarked default); drop`);
    } else if (single && /^standard$/i.test(v)) {
      err("variant-filler", `${gearLabel(r)}: "Standard" on a one-row product is filler; drop`);
    } else if (dims.some((d) => /^per \w+$/i.test(d)) && !/\btrekking\s+poles?$/i.test(r.name.trim()) && !hasPackSibling(r)) {
      err("variant-filler", `${gearLabel(r)}: unit label in "${v}" restates the row — only trekking poles, or a row beside a multi-pack sibling, carry one`);
    }
  }

  // --- WARNING: a food row with no kcal ---------------------------------------
  // Calories are the point of a food row; one without them is a to-do (the row
  // stays until a nutrition panel can be cited — see researchChecks kcal-quote).
  for (const r of rows) {
    if (r.categoryHint === "consumable" && traitsOf(r.commonName).food && r.kcal == null) {
      warn("food-kcal-missing", `${gearLabel(r)}: a food row with no kcal — cite a nutrition panel (kcal + kcal_source_url + kcal_quote on the research row)`);
    }
  }

  // --- WARNING: a food row still at net weight -------------------------------
  // A food row stores what you CARRY — contents plus pouch — whenever the maker
  // publishes a total/package weight or someone has weighed one. Makers mostly
  // print net contents only, and a cook-in pouch is 20–30 g, so a net-only row
  // undercounts a five-dinner trip by ~100 g. Such a row says "net" in its variant
  // so the reader knows, and shows up here as a to-do until a packaged weight is
  // found. (Bars and chews stay at label weight: the wrapper is a gram or two and
  // nobody publishes it.) Fuel canisters keep "net fuel" — that is the gas alone.
  for (const r of rows) {
    const dims = (r.variant ?? "").split(/,\s*/);
    if (dims.includes("net") && r.categoryHint === "consumable") {
      warn("food-net-weight", `${gearLabel(r)}: weight excludes the pouch — find the packaged weight (maker "total weight", or a scale) and drop "net"`);
    }
  }

  // --- ERROR: unit-label phrasing -------------------------------------------
  // One weight per one thing reads "per bar" / "per stake", never "single bar",
  // "each", or "one pouch"; multiples read "3-pack" or "sleeve of 10".
  for (const r of rows) {
    const v = r.variant ?? "";
    if (/\b(?:single|one)\s+(?:bar|pouch|sleeve|stick|waffle|packet|serve|serving|bowl|pack|wipe|tablet)\b|\beach\b/i.test(v)) {
      err("variant-unit-label", `${gearLabel(r)}: "${v}" — say "per <unit>" for one item, "<n>-pack" for several`);
    }
  }

  // --- ERROR: variant just repeats the name (e.g. "Copper Spur HV UL3" + "UL3") -
  for (const r of rows) {
    if (r.variant && isVariantRedundant(r.name, r.variant)) {
      err("variant-redundant", `${gearLabel(r)}: variant "${r.variant}" already in the name — clear it`);
    }
  }

  // --- ERROR: the variant and the row's attributes disagree ----------------------
  // The variant is prose; `attributes` is the same fact as data, read out of the
  // variant by the build and then merged with what research wrote by hand.
  // extractAttributes reads what a variant says outright ("20F" → temp_f 20, "Men's
  // US 9" → fit + size, "65L" → volume_l 65), so a shipped row carries every axis its
  // variant states (a hand-edited CSV that dropped one fails here), a hand-written
  // value never contradicts the variant, and a variant never claims one axis twice
  // ("Regular, Long"). What the variant does NOT state (a researched R-value, a rating
  // on a quilt sold one way) is free.
  for (const r of rows) {
    const stated = extractAttributes(r.variant, r.commonName, r.categoryHint, (c) => err("attr-conflict", `${gearLabel(r)}: the variant claims one axis twice, ${c}`));
    for (const key of Object.keys(stated) as AttributeKey[]) {
      const want = stated[key];
      const have = r.attributes?.[key];
      if (have === undefined) {
        err("attr-missing", `${gearLabel(r)}: the variant states ${key}=${want} but the attributes column lacks it — rebuild with catalog:build`);
      } else if (have !== want) {
        err("attr-mismatch", `${gearLabel(r)}: attributes say ${key}=${have} but the variant reads ${key}=${want}`);
      }
    }
  }

  // --- WARNING: an axis the gear type is sold by, still unresearched --------------
  // A to-do list, not a convention. A quilt is sold by temperature and length, a pad
  // by R-value, a pack by volume, a shoe by fit and size, a garment by size
  // (shared/catalogAxes.ts says which); the build types what variant strings state,
  // and these are the rows where the maker's page still has to be read. Worked in
  // usage order (the catalog counts picks; the audit can't see them, so the ordered
  // snapshot lives with #336).
  // An axis the maker was found not to publish (attributes_unpublished on the research
  // row) is researched, not missing: the list names only rows nobody has read yet.
  for (const r of rows) {
    const missing = soldByOf(r.commonName).filter((k) => r.attributes?.[k] === undefined && !r.attributesUnpublished.includes(k));
    if (missing.length) warn("attr-gap", `${gearLabel(r)}: a ${(r.commonName ?? "").toLowerCase()} without ${missing.join(", ")} — read the maker's page`);
  }

  return out;
}
