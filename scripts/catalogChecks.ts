// Standing data-quality checks for the catalog — the defect classes we kept
// hand-cleaning, turned into deterministic checks so they fail CI instead of
// surviving to an ad-hoc spot-check later.
//
// ERRORS gate the build (npm test fails, and CI runs npm test on every PR). Every
// CONVENTION is an error: a rule that only warns is a rule that drifts. The
// WARNINGS left are not conventions but to-do lists for a human: pouch meals still
// at net weight (until someone weighs one), food rows without kcal, and rows missing
// an axis their gear type is sold by. Research-level checks (a weight outside its
// category's range, the cited quote vs the stored weight, kcal vs its panel) live in
// researchChecks.ts.
//
// Pure + dependency-light on purpose (no DB import) so the gating test stays fast.

import { identity, type CatalogCsvRow } from "./catalogCsv";
import { isVariantRedundant, normalizeVariant, normKey, SPACED_UNITS } from "../shared/catalogQuality";
import { soldByOf, traitsOf, type AttributeKey } from "../shared/catalogAxes";
import { extractAttributes, SHOE_REGIONS } from "./catalogAttributes";
import { GEAR_TYPE_ALIASES } from "./gearTypes";

export interface Finding {
  level: "error" | "warning";
  code: string;
  message: string;
  /** What the finding is about, stable while the rest of the catalog changes: the rule's
   *  code and the row (or rows, token, or gear type) it names. A message can carry counts
   *  ("32 of 33 rows"), so it can't be one; houseRuleProblems tells a finding the catalog
   *  already had from one a new row brings by this. */
  key: string;
  /** The research file a research finding is about; findingText puts it in front. */
  file?: string;
}

/** A finding as the audit prints it: the file it is about, then its message. */
export const findingText = (f: Finding) => (f.file ? `${f.file}: ${f.message}` : f.message);

/** A row in a finding's key: its exact identity, case kept as case-collision keeps it. */
const rowKey = (r: { brand?: string | null; name?: string | null; variant?: string | null }) => identity(r.brand ?? null, r.name ?? "", r.variant ?? null);
/** Two rows in a finding's key, in one order whichever came first. */
const pairKey = (a: CatalogCsvRow, b: CatalogCsvRow) => [rowKey(a), rowKey(b)].sort().join("|");
/** A set of spellings in a finding's key, in one order: a further spelling is a new finding. */
const spellingsKey = (spellings: Set<string>) => [...spellings].sort().join("|");

// Prose that should never appear in a variant (variant = clean size/config only).
const VARIANT_COMMENTARY =
  /\b(not specified|current catalog|current live|no medium|base config|sku page|lot average|closest config|page does not|removable cape|spec scales|weight not published|measured weight per|starting weight|manufacturer spec size|only size offered|sold in a|sold individually)\b|colou?rway|outdoorgearlab|\bvia [a-z]|scale\)/i;

// Colour words that are weight-irrelevant and shouldn't fragment identity.
// (Checked on VARIANT only — product names like "Silver Shadow" live in `name`.)
// The second line is colourway words a maker names a colour by ("Stone", "Moss"), none of
// them a size or a version; words that are also product words (gold, copper, sky) stay out.
const COLOUR_WORDS =
  /\b(black|white|grey|gray|blue|navy|red|green|olive|khaki|tan|charcoal|sage|orange|yellow|purple|pink|brown|silver|graphite|slate|teal|maroon|burgundy|cream|beige|ivory|coyote|avalanche|habitat|stone|sand|moss|forest|clay|rust|onyx|midnight|ocean|indigo|cobalt|crimson|scarlet|plum|mocha|espresso|heather|bronze)\b/gi;

// Pole-family items (trekking poles + their baskets/paws) — the ONE class of
// paired gear that keeps a "per pair" unit label, since single-pole use is a real
// setup. Used to exempt them from the "drop per pair" rule below.
const POLE_ITEM = /\b(pole|poles|paw|paws|basket|baskets)\b/i;

// A number and its unit split by a space, in the units normalizeVariant closes up: the
// one list, so the check can't refuse a unit the normalizer leaves spaced, or miss one.
const SPACED_UNIT = new RegExp(String.raw`\d\s+(?:${SPACED_UNITS})\b`);
// Vulgar fractions: a unit mark in a name, and in a variant ("5/8in", not "⅝in").
const FRACTIONS = "¼½¾⅓⅔⅛⅜⅝⅞";
const NAME_UNIT_MARK = new RegExp(String.raw`\d\s*["″”′]|\d'(?!s\b)|°|[${FRACTIONS}]`);
const VARIANT_UNIT_MARK = new RegExp(`["'°${FRACTIONS}]`);

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
  // `about` is what the finding names: a row's identity, a pair of rows, a token, a gear type
  const err = (code: string, about: string, message: string) => out.push({ level: "error", code, message, key: `${code}|${about}` });
  const warn = (code: string, about: string, message: string) => out.push({ level: "warning", code, message, key: `${code}|${about}` });

  // --- ERROR: a row shipped without a gear type ------------------------------
  // It's the label a pick pre-fills onto the user's item, so a blank one silently
  // costs every future list that adds this row. catalogBuild.ts already fails the
  // build on it; this makes the committed CSV answer for it too.
  for (const r of rows) {
    if (!r.commonName?.trim()) err("common-name-missing", rowKey(r), `${gearLabel(r)}: no gear type`);
  }

  // --- ERROR: a gear type that the drift map should have collapsed -----------
  // A label that is still an ALIAS key never went through normalizeGearType (or was
  // hand-edited into the CSV afterwards), so the vocabulary has two words for one thing.
  for (const r of rows) {
    const canon = r.commonName && GEAR_TYPE_ALIASES[r.commonName.trim().toLowerCase()];
    if (canon) err("common-name-drift", rowKey(r), `${gearLabel(r)}: gear type "${r.commonName}" → canonical "${canon}"`);
  }

  // --- ERROR: the name starts with its own brand ------------------------------
  // The UI renders brand + name joined ("Apple" + "Apple Watch SE 3" → "Apple Apple
  // Watch SE 3"), so the brand lives in `brand` only. A collab is a brand of its own
  // ("Zpacks x Vaucluse"), and an eponymous product takes a descriptor for a name.
  for (const r of rows) {
    const b = (r.brand ?? "").trim();
    if (b && new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(r.name.trim())) {
      err("name-repeats-brand", rowKey(r), `${gearLabel(r)}: name starts with the brand — drop it from the name (or make the collab the brand)`);
    }
  }

  // --- ERROR: a qualifier hiding in the name ----------------------------------
  // " - Regular", "(low)", "(2024)", "(SP129)" are configs, not names: they go in
  // `variant`. Parentheses are allowed on food rows (the flavor convention:
  // "Energy Bar (Chocolate Chip)").
  for (const r of rows) {
    if (/\s[-–]\s/.test(r.name)) err("name-qualifier", rowKey(r), `${gearLabel(r)}: " - " suffix in the name belongs in the variant`);
    else if (/\(/.test(r.name) && r.categoryHint !== "consumable") {
      err("name-qualifier", rowKey(r), `${gearLabel(r)}: parenthetical in the name belongs in the variant (parens are for a food row's flavor)`);
    }
  }

  // --- ERROR: a gender in the name ---------------------------------------------
  // Men's / Women's is the fit, an axis the build reads out of the variant ("Women's
  // Medium" → fit + size). In the name it is invisible to that, and it splits one
  // product into two names ("Women's Tarn Down Jacket" beside "Men's Tarn Down Jacket").
  for (const r of rows) {
    if (/\b(?:Men|Women)'s\b/i.test(r.name)) {
      err("name-gender", rowKey(r), `${gearLabel(r)}: Men's / Women's goes in the variant ("Women's Medium"), where it is read as the fit`);
    }
  }

  // --- ERROR: a unit mark in the name -------------------------------------------
  // The variant's unit rule holds in the name too: 8in, not 8"; 7ft x 9ft, not 7' x 9';
  // 15F, not 15°F; 5/8in, not ⅝". A size the maker sells several of is a variant.
  for (const r of rows) {
    if (NAME_UNIT_MARK.test(r.name)) {
      err("name-unit-mark", rowKey(r), `${gearLabel(r)}: a unit mark in the name — spell the unit ("8in", "7ft", "15F", "5/8in"), or move a size to the variant`);
    }
  }

  // --- ERROR: variant carries research commentary instead of a clean config ---
  // Keyword-driven (deterministic, low false-positive). A legit size spec like
  // "(US size 9 / M9)" or "(tapered)" must NOT trip — only prose markers do.
  for (const r of rows) {
    const v = r.variant ?? "";
    if (v && VARIANT_COMMENTARY.test(v)) {
      err("variant-commentary", rowKey(r), `${gearLabel(r)}: variant reads like a note, not a config: "${v}"`);
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
    byProduct.getOrInsertComputed(k, () => []).push(r);
  }
  for (const group of byProduct.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const wa = group[a]!.weightMg;
        const wb = group[b]!.weightMg;
        const va = normKey(group[a]!.variant);
        const vb = normKey(group[b]!.variant);
        const oneBlank = va === "" || vb === "";
        const sameWeight = oneBlank ? Math.abs(wa - wb) <= 0.01 * Math.max(wa, wb) : wa === wb;
        if (!sameWeight) continue;
        const subset = oneBlank || va.includes(vb) || vb.includes(va) || va === vb;
        if (subset) {
          err(
            "duplicate-row",
            pairKey(group[a]!, group[b]!),
            `${group[a]!.brand} ${group[a]!.name}: same weight (${wa} mg vs ${wb} mg) for variants "${group[a]!.variant ?? ""}" and "${group[b]!.variant ?? ""}" — likely the same product twice`,
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
    byBrand.getOrInsertComputed(k, () => []).push(r);
  }
  for (const group of byBrand.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        if (group[a]!.weightMg !== group[b]!.weightMg) continue;
        const ta = normKey(group[a]!.name).split(" ").filter(Boolean);
        const tb = normKey(group[b]!.name).split(" ").filter(Boolean);
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
          pairKey(group[a]!, group[b]!),
          `${group[a]!.brand}: "${group[a]!.name}" and "${group[b]!.name}" — same weight (${group[a]!.weightMg} mg), one name contains the other; likely the same product`,
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
          pairKey(r, twin),
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
    brandSpellings.getOrInsertComputed(normKey(b), () => new Set()).add(b);
  }
  for (const spellings of brandSpellings.values()) {
    if (spellings.size > 1) err("brand-case-split", spellingsKey(spellings), `one brand, ${spellings.size} spellings: ${[...spellings].map((s) => `"${s}"`).join(" / ")} — pick one`);
  }

  // --- ERROR: one variant token spelled two ways ("Standard" / "standard") ------
  const tokenSpellings = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const d of (r.variant ?? "").split(/,\s*/)) {
      if (!d) continue;
      tokenSpellings.getOrInsertComputed(d.toLowerCase(), () => new Set()).add(d);
    }
  }
  for (const spellings of tokenSpellings.values()) {
    if (spellings.size > 1) err("variant-case-split", spellingsKey(spellings), `one variant token, ${spellings.size} spellings: ${[...spellings].map((s) => `"${s}"`).join(" / ")} — pick one`);
  }

  // --- ERROR: a size word leading the name ("Large Food Bag") -------------------
  // A size-named family is ONE product with size variants: "Food Bag" [L].
  for (const r of rows) {
    if (/^(?:X-Small|Small|Small-Plus|Medium|Medium-Plus|Large|X-Large|XX-Large)\b/i.test(r.name.trim())) {
      err("name-size-prefix", rowKey(r), `${gearLabel(r)}: the size belongs in the variant — one name for the family, a letter per size`);
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
      err("name-plural-family", rowKey(r), `${gearLabel(r)}: a family name is singular — "${r.name.trim().replace(/(ie)s$/, "y").replace(/(ch|sh|x|s)es$/, "$1").replace(/s$/, "")}" with a size in the variant`);
    }
  }

  // --- ERROR: a row filed where none of its gear type's siblings are ------------
  // category_hint drives sort order, the plausibility band, and the consumable
  // flag; a running cap in `other` beside 17 caps in `clothing` is a misfile. One
  // gear type has one category (2026-11-25; it was "5+ rows, 90% agreeing" until a
  // sunscreen sat in `other` beside eight in `consumable`). A thing that is filed
  // differently is a different gear type ("Gas lantern" in cook, "Lantern" in
  // electronics). A tie names every row, so someone decides. A row with no gear type
  // takes no part: rows that lack one aren't one kind of thing, and common-name-missing
  // has already named each.
  const catsByType = new Map<string, Map<string, number>>();
  const typed = rows.filter((r) => r.commonName?.trim());
  for (const r of typed) {
    const k = (r.commonName ?? "").toLowerCase();
    const m = catsByType.getOrInsertComputed(k, () => new Map());
    m.set(r.categoryHint ?? "other", (m.get(r.categoryHint ?? "other") ?? 0) + 1);
  }
  for (const r of typed) {
    const m = catsByType.get((r.commonName ?? "").toLowerCase())!;
    if (m.size < 2) continue;
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [[home, n], [, runnerUp]] = [...m.entries()].sort((a, b) => b[1] - a[1]) as [[string, number], [string, number]];
    if ((r.categoryHint ?? "other") !== home || n === runnerUp) {
      err("category-outlier", `${(r.commonName ?? "").toLowerCase()}|${rowKey(r)}`, `${gearLabel(r)}: filed under ${r.categoryHint} while ${n} of ${total} "${r.commonName}" rows are ${home} — one gear type, one category (move it, or give it its own gear type)`);
    }
  }

  // --- ERROR: a number and its unit split, or a unit mark, in a variant ---------
  // normalizeVariant emits "6ft" / "400ml" / "5ft 6in"; a hand edit that slips past
  // it ("6 ft", '17" torso', "⅝in", "20°F") fails here. Numbers are plain: "1L" not
  // "1.0L", "6ft" not "6ft 0in", a bare dimension "20x72" not "20 x 72".
  for (const r of rows) {
    const v = r.variant ?? "";
    if (
      SPACED_UNIT.test(v) ||
      VARIANT_UNIT_MARK.test(v.replace(/\b\w+'s\b/g, "")) ||
      /\b\d+\.0(?=[A-Za-z])|\dft 0in\b|\b\d+(?:\.\d+)? x \d+(?:\.\d+)?\b/.test(v)
    ) {
      err("variant-unit-spacing", rowKey(r), `${gearLabel(r)}: "${v}" — a number and its unit are one token ("6ft", "400ml", "5/8in"), plainly written ("1L", "6ft", "20x72"), with no unit marks`);
    }
  }

  // --- ERROR: case-only identity collision (e.g. "NEMO" vs "Nemo") ----------
  const byCI = new Map<string, CatalogCsvRow>();
  for (const r of rows) {
    const ciNorm = (x: string | null) => (x || "").toLowerCase().replace(/\s+/g, " ").trim();
    // preserve punctuation so "Lone Peak 9" vs "Lone Peak 9+" stay distinct
    const ci = ciNorm(r.brand) + "|" + ciNorm(r.name) + "|" + ciNorm(r.variant);
    const exact = identity(r.brand, r.name, r.variant);
    const prev = byCI.get(ci);
    if (prev) {
      if (identity(prev.brand, prev.name, prev.variant) !== exact) {
        err("case-collision", [rowKey(r), rowKey(prev)].sort().join("|"), `${gearLabel(r)} collides case-insensitively with ${gearLabel(prev)} (normalize casing)`);
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
      err("provenance", rowKey(r), `${gearLabel(r)}: weight_source=manufacturer but cited to a review site (${host}) — re-source or mark measured`);
    }
  }

  // --- ERROR: colour-as-attribute in variant ------------------------------
  // The word is named, not the whole variant: "Trail Team Edition, Stone" quoted whole
  // read as if every part of it were refused, when only "Stone" was.
  // Every colour word, so "Black/Red" isn't refused for "Black" and then again for "Red".
  for (const r of rows) {
    const colours = [...new Set(r.variant?.match(COLOUR_WORDS) ?? [])];
    if (colours.length) {
      const named = colours.map((c) => `"${c}"`).join(", ");
      err("colour-variant", rowKey(r), `${gearLabel(r)}: ${named} in variant "${r.variant}" ${colours.length > 1 ? "are colours" : "is a colour"} — colour rarely affects weight, so drop ${colours.length > 1 ? "them" : "it"}`);
    }
  }

  // --- ERROR: an edition in variant ------------------------------------------
  // An edition, collaboration release or colourway special is not a size or a config.
  // One that weighs what the base product weighs IS the base product (no variant); one
  // sold as its own build, with its own weight, is a product of its own and names the
  // edition in `name` ("Kindle Paperwhite Signature Edition"), as every research row
  // that has one already does.
  for (const r of rows) {
    if (/\beditions?\b/i.test(r.variant ?? "")) {
      err("variant-edition", rowKey(r), `${gearLabel(r)}: "${r.variant}" — an edition isn't a size; one that weighs the same is the base product (no variant), one sold as its own build names the edition in the name`);
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
      err("pole-unit", rowKey(r), `${gearLabel(r)}: trekking poles should state "per pair" (the catalog's single pole-weight convention)`);
    }
  }

  // --- ERROR: "per pair" label on non-pole gear ---------------------------
  // House policy: worn-as-a-pair apparel (footwear, socks, gaiters, gloves, etc.)
  // is stored as a PAIR weight with NO label — nobody carries one boot, so the
  // annotation is noise. Only trekking poles (above) keep a unit. A stray
  // "per pair" on anything else is a leftover to drop.
  for (const r of rows) {
    if (/\bper pair\b/i.test(r.variant ?? "") && !POLE_ITEM.test(r.name)) {
      err("per-pair-label", rowKey(r), `${gearLabel(r)}: drop "per pair" — worn-pair apparel is stored as a pair weight without the label`);
    }
  }

  // --- ERROR: variant isn't in canonical form (run normalizeVariant) -------
  for (const r of rows) {
    const v = r.variant ?? "";
    if (v && normalizeVariant(v) !== v) {
      err("variant-noncanonical", rowKey(r), `${gearLabel(r)}: variant "${v}" → canonical "${normalizeVariant(v)}"`);
    }
  }

  // --- ERROR: size written in the wrong style ---------------------------------
  // House convention (2026-09-12, reversing 2026-09-05): S/M/L-family sizes are WORDS
  // in the variant — Small, Medium, Large, X-Small, X-Large — with an optional gender
  // prefix ("Men's Medium"), because that is what a person reads on the row (Ryan: "I
  // want the catalogue to say Medium"). A range keeps the maker's letters ("S/M"), and
  // the attributes column keeps the letter for the size axis. "Extra small" and the
  // like are the same words misspelled for the catalog; normalizeVariant does not
  // rewrite those, so they are named here.
  const SIZE_LETTER = /^(?:(?:men's|women's)\s+)?(?:xxs|xs|s|m|l|xl|xxl)(?:\s+(?:torso|hipbelt))?$/i;
  const SIZE_MISSPELT = /^(?:(?:men's|women's)\s+)?(?:extra small|extra large|xsmall|xlarge|med|sm|lg)$/i;
  for (const r of rows) {
    if (!r.variant) continue;
    for (const dim of r.variant.split(/,\s*/)) {
      if (SIZE_LETTER.test(dim)) err("variant-size-style", `${rowKey(r)}|${dim}`, `${gearLabel(r)}: write the size as a word ("M" → "Medium"), not "${dim}"`);
      else if (SIZE_MISSPELT.test(dim)) err("variant-size-style", `${rowKey(r)}|${dim}`, `${gearLabel(r)}: write the size as Small / Medium / Large / X-Small / X-Large, not "${dim}"`);
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
      err("footwear-size", rowKey(r), `${gearLabel(r)}: footwear size "${v}" needs a region — "Men's US 9", "Women's US 8", "UK 8"`);
    }
  }

  // --- ERROR: a variant that distinguishes nothing --------------------------
  // A variant exists to tell a row apart from a sibling, or to state a size the
  // maker sells several of. So: "One size" and "Unisex" say nothing; "Standard" on
  // a product with one row is filler; "per bar" on the only row of "Energy Bar"
  // restates the name (a unit label earns its place only beside a multi-pack
  // sibling, or on trekking poles).
  const siblings = (r: CatalogCsvRow) => byProduct.get(`${normKey(r.brand)}|${normKey(r.name)}`)!;
  // a unit label is earned when a sibling row is counted differently: "sleeve of 10"
  // beside "per tablet", or "per pair" beside "per pole"
  const hasPackSibling = (r: CatalogCsvRow) =>
    siblings(r).some((o) => o !== r && /\b(\d+-pack|of \d+|per \w+)\b/i.test(o.variant ?? ""));
  for (const r of rows) {
    const v = r.variant ?? "";
    if (!v) continue;
    const single = siblings(r).length === 1;
    const dims = v.split(/,\s*/);
    if (dims.some((d) => /^(one size|unisex|1 serving)$/i.test(d))) {
      err("variant-filler", rowKey(r), `${gearLabel(r)}: "${v}" — "One size" / "Unisex" / "1 serving" distinguish nothing (single-serving is the unmarked default); drop`);
    } else if (single && /^standard$/i.test(v)) {
      err("variant-filler", rowKey(r), `${gearLabel(r)}: "Standard" on a one-row product is filler; drop`);
    } else if (dims.some((d) => /^per \w+$/i.test(d)) && !/\btrekking\s+poles?$/i.test(r.name.trim()) && !hasPackSibling(r)) {
      err("variant-filler", rowKey(r), `${gearLabel(r)}: unit label in "${v}" restates the row — only trekking poles, or a row beside a multi-pack sibling, carry one`);
    }
  }

  // --- WARNING: a food row with no kcal ---------------------------------------
  // Calories are the point of a food row; one without them is a to-do (the row
  // stays until a nutrition panel can be cited — see researchChecks kcal-quote).
  for (const r of rows) {
    if (r.categoryHint === "consumable" && traitsOf(r.commonName).food && r.kcal == null) {
      warn("food-kcal-missing", rowKey(r), `${gearLabel(r)}: a food row with no kcal — cite a nutrition panel (kcal + kcal_source_url + kcal_quote on the research row)`);
    }
  }

  // --- ERROR: kcal on a row that is not food -----------------------------------
  // A catalog kcal lands on every list row picked from it, where the totals and the
  // food plan count it as something eaten. A canister's energy content is a real
  // number a maker may print and a researcher may cite, and it is exactly the number
  // the editor refuses to invite on a fuel row (shared/fuel.ts, offersKcal) — a pick
  // must not be the way it gets in. Food is what GEAR_TRAITS says is food.
  for (const r of rows) {
    if (r.kcal != null && !traitsOf(r.commonName).food) {
      err("kcal-on-non-food", rowKey(r), `${gearLabel(r)}: kcal on a row whose gear type is not food — only food rows carry calories (a canister's energy content is not a ration)`);
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
      warn("food-net-weight", rowKey(r), `${gearLabel(r)}: weight excludes the pouch — find the packaged weight (maker "total weight", or a scale) and drop "net"`);
    }
  }

  // --- ERROR: unit-label phrasing -------------------------------------------
  // One weight per one thing reads "per bar" / "per stake", never "single bar",
  // "each", or "one pouch"; multiples read "3-pack" or "sleeve of 10".
  for (const r of rows) {
    const v = r.variant ?? "";
    if (/\b(?:single|one)\s+(?:bar|pouch|sleeve|stick|waffle|packet|serve|serving|bowl|pack|wipe|tablet)\b|\beach\b/i.test(v)) {
      err("variant-unit-label", rowKey(r), `${gearLabel(r)}: "${v}" — say "per <unit>" for one item, "<n>-pack" for several`);
    }
  }

  // --- ERROR: variant just repeats the name (e.g. "Copper Spur HV UL3" + "UL3") -
  // Whole, or one part of it: "Elementum Pack Ultra [Ultra, 50L]" says Ultra twice,
  // and a sleeping bag named for its rating ("Spark 15F", "Egret UL 20") doesn't say
  // 15F again in the variant; the rating goes in `attributes` instead. A bag whose
  // name carries no rating states it in the variant ("UltraLite [20F, 6ft]").
  for (const r of rows) {
    if (!r.variant) continue;
    if (isVariantRedundant(r.name, r.variant)) {
      err("variant-redundant", rowKey(r), `${gearLabel(r)}: variant "${r.variant}" already in the name — clear it`);
      continue;
    }
    const nameWords = ` ${normKey(r.name.replace(/'/g, ""))} `;
    for (const part of r.variant.split(/,\s*/)) {
      const rating = /^(-?\d+)F$/.exec(part);
      const repeated = rating
        ? new RegExp(` ${rating[1]}(?: ?f)? `).test(nameWords)
        : isVariantRedundant(r.name, part);
      if (repeated) err("variant-redundant", `${rowKey(r)}|${part}`, `${gearLabel(r)}: "${part}" in the variant is already in the name — drop it${rating ? " (the rating goes in attributes)" : ""}`);
    }
  }

  // --- ERROR: a variant's axes out of order ---------------------------------------
  // Gender, then rating, then fill power, then length or size, then the rest:
  // "Women's, 15F, Regular", "20F, 850FP, Long". Ninety percent of rows already read
  // that way; a row that doesn't ("Regular, 20F") reads as a different product.
  const AXIS_ORDER: [RegExp, string][] = [
    [/^(?:Men|Women)'s\b/, "gender"],
    [/^-?\d+F$/, "rating"],
    [/^\d+\+?FP$/, "fill power"],
    [/^(?:(?:X{1,3}-)?(?:Small|Large)|Medium|Short|Regular|Long|Tall|Petite)(?: Wide| Mummy| Rectangular)?$|^\d+ft(?: \d+in)?(?: Wide)?$/, "length or size"],
  ];
  for (const r of rows) {
    const ranks = (r.variant ?? "").split(/,\s*/).map((p) => AXIS_ORDER.findIndex(([re]) => re.test(p))).filter((i) => i >= 0);
    const at = ranks.findIndex((x, i) => i > 0 && x < ranks[i - 1]!);
    if (at > 0) {
      err("variant-axis-order", rowKey(r), `${gearLabel(r)}: "${r.variant}" — ${AXIS_ORDER[ranks[at]!]![1]} goes before ${AXIS_ORDER[ranks[at - 1]!]![1]} (gender, rating, fill power, length or size, then the rest)`);
    }
  }

  // --- ERROR: the variant and the row's attributes disagree ----------------------
  // The variant is prose; `attributes` is the same fact as data, read out of the
  // variant by the build and then merged with what research wrote by hand.
  // extractAttributes reads what a variant says outright ("20F" → temp_f 20, "Men's
  // US 9" → fit + size, "65L" → volume_l 65), so a shipped row carries every axis its
  // variant states (a hand-edited CSV that dropped one fails here), a hand-written
  // value never contradicts the variant, and a variant never claims one axis twice —
  // a contradiction ("Regular, Long") or the same fact in a second scale ("Medium,
  // JP 3", "Regular, 6ft"): each axis is stated once, in the maker's own scale. What
  // the variant does NOT state (a researched R-value, a rating on a quilt sold one way)
  // is free.
  for (const r of rows) {
    const stated = extractAttributes(r.variant, r.commonName, r.categoryHint, (c) => err("attr-conflict", `${rowKey(r)}|${c}`, `${gearLabel(r)}: the variant claims one axis twice, ${c}`));
    for (const key of Object.keys(stated) as AttributeKey[]) {
      const want = stated[key];
      const have = r.attributes?.[key];
      if (have === undefined) {
        err("attr-missing", `${rowKey(r)}|${key}`, `${gearLabel(r)}: the variant states ${key}=${want} but the attributes column lacks it — rebuild with catalog:build`);
      } else if (have !== want) {
        err("attr-mismatch", `${rowKey(r)}|${key}`, `${gearLabel(r)}: attributes say ${key}=${have} but the variant reads ${key}=${want}`);
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
    if (missing.length) warn("attr-gap", rowKey(r), `${gearLabel(r)}: a ${(r.commonName ?? "").toLowerCase()} without ${missing.join(", ")} — read the maker's page`);
  }

  return out;
}
