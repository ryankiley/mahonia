// Typed attributes on a catalog row: the axes a variant string has always crammed into
// prose, read out of it at build time. "20F, 950FP, Regular" is a temperature, a fill
// power and a length; "Men's US 9" is a fit and a size; "65L" is a volume. The build
// serialises them into one CSV column, a research row adds by hand only what its variant
// does not state, and the checks hold every value to one form and the two sources to
// each other.
//
// Three parts, all pure:
//   • validateAttributes: the unit rules. Every value has one canonical form, so a row
//     can't say "20°F" here and "20F" there, or store a fill power as "850fp".
//   • serializeAttributes / parseAttributes: the CSV cell, `temp_f=20; length=Regular`.
//   • extractAttributes: the MECHANICAL reading of a variant string, keyed on the gear
//     type where a token is ambiguous ("Regular" is a length on a quilt, a torso on a
//     pack, an inseam on pants, a size on a pillow; "3L" is litres on a reservoir and a
//     fabric on a jacket). scripts/build-catalog.ts runs it on every row; the CSV check
//     re-runs it, so a hand-edited CSV that says "20F" without temp_f 20 fails the build.
//     It never emits a value the validator would refuse ("330mAh", "10, 000mAh" stay in
//     the variant for research), and it reports a variant that claims one axis twice —
//     a contradiction or a second scale alike ("Medium, JP 3"): each axis is stated
//     once, in the maker's own scale.
//     What it does NOT read (a bare "Standard" that is a width on a Zpacks quilt and a
//     length on a Hammock Gear one, "LW Mummy", "Double Wide") is left for research.
//
// The vocabulary (keys, row shape, what each gear type is sold by) is shared/catalogAxes.ts.
// Build-time only otherwise: nothing seeds the column to the database yet; #335 adds it
// when search returns products with axes.

import { ATTRIBUTE_KEYS, INSEAM_TYPE, traitsOf, type AttributeKey, type RowAttributes } from "../shared/catalogAxes";
import { ML_PER_UNIT } from "../shared/water";

export { ATTRIBUTE_KEYS } from "../shared/catalogAxes";
export type { AttributeKey, RowAttributes } from "../shared/catalogAxes";
import { sizeWordsToLetters } from "../shared/catalogQuality";

// --- canonical forms ---------------------------------------------------------

export const LETTER = "XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL";
const LETTER_SIZE = new RegExp(`^(?:${LETTER})\\+?$`);
const LETTER_RANGE = new RegExp(`^(?:${LETTER})/(?:${LETTER})$`);
/** The regions a footwear size is written in; the footwear-size check reads the same list. */
export const SHOE_REGIONS = "US|UK|EU|JP";
const SHOE_SIZE = new RegExp(`^(?:${SHOE_REGIONS}) \\d{1,2}(?:\\.5)?$`);
// size words a maker sells several of, outside the S/M/L family (which the variant
// spells as words too since 2026-09-12, but which this reader takes back to the letter
// first — see the top of the loop in attributesFromVariant — so the size axis stays
// the letter it has always been)
const WORD_SIZE = /^(?:X-Small|Small|Medium|Large|X-Large|Regular|Short|Long|Tall|Wide|Slim|Mini|Jumbo|Big|Nano|Petite|Standard)$/;
// the maker's own scale: Gnuhr "4" / "3-4", Superfeet "D", a waist "32"
const SCALE_SIZE = /^(?:\d{1,2}(?:-\d{1,2})?|[A-Z])$/;
const LENGTH_WORDS = "Short|Regular|Long|Tall|Petite|Small|Medium|Large|X-Large";
const LENGTH_WORD = new RegExp(`^(?:${LENGTH_WORDS}|Standard|${LETTER})$`);
const LENGTH_MEASURE = /^(?:\d+ft(?: [1-9]\d?in)?|\d+(?:\.\d+)?in|\d+(?:-\d+)?cm|\d+(?:\.\d+)?m)$/;
const WIDTH_FORM = /^(?:Slim|Standard|Regular|Wide|Extra Wide|\d+(?:\.\d+)?in|\d+cm)$/;
const TORSO_FORM = new RegExp(`^(?:${LETTER}|(?:${LETTER})/(?:${LETTER})|Short|Regular|Long|Tall|\\d+(?:\\.\\d+)?in|\\d+-\\d+in)$`);
const FIT_FORM = /^(?:Men's|Women's|Unisex|Kids)$/;
const FUEL_FORM = /^(?:isobutane|butane|propane|alcohol|solid fuel|wood|white gas)$/;

// One table per value kind. `_everyKey` fails to compile if a key of ATTRIBUTE_KEYS is in
// neither, so a new axis cannot validate as "anything" by being forgotten here.
const NUMERIC_RULES = {
  temp_f: { min: -60, max: 80, step: 1, why: "a whole °F between -60 and 80" },
  fill_power: { min: 500, max: 1000, step: 1, why: "a whole fill power between 500 and 1000" },
  r_value: { min: 0.5, max: 15, step: 0.1, why: "an R-value between 0.5 and 15 with at most one decimal" },
  persons: { min: 1, max: 8, step: 0.5, why: "1–8 people, in halves" },
  volume_l: { min: 0.001, max: 500, step: 0.001, why: "litres, 0.001 to 500, to the millilitre" },
  capacity_mah: { min: 500, max: 200_000, step: 1, why: "whole mAh between 500 and 200000" },
  fuel_g: { min: 50, max: 1000, step: 1, why: "whole grams between 50 and 1000" },
} as const;
type NumericKey = keyof typeof NUMERIC_RULES;
const STRING_FORM = {
  fit: (v: string) => FIT_FORM.test(v),
  size: (v: string) => LETTER_SIZE.test(v) || LETTER_RANGE.test(v) || SHOE_SIZE.test(v) || WORD_SIZE.test(v) || SCALE_SIZE.test(v),
  torso: (v: string) => TORSO_FORM.test(v),
  length: (v: string) => LENGTH_WORD.test(v) || LENGTH_MEASURE.test(v),
  width: (v: string) => WIDTH_FORM.test(v),
  fuel: (v: string) => FUEL_FORM.test(v),
} as const;
type StringKey = keyof typeof STRING_FORM;
const _everyKey: Record<AttributeKey, unknown> = { ...NUMERIC_RULES, ...STRING_FORM };
void _everyKey;

const isAttributeKey = (k: string): k is AttributeKey => (ATTRIBUTE_KEYS as readonly string[]).includes(k);
const isNumericKey = (k: string): k is NumericKey => Object.hasOwn(NUMERIC_RULES, k);
/** On the grid of `step` (to floating-point tolerance): 0.525 on 0.001, 1.5 on 0.5. */
const onStep = (v: number, step: number) => {
  const q = v / step;
  return Math.abs(q - Math.round(q)) < 1e-6;
};

/** Every way a row's attributes can be wrong, as messages; `[]` when they're fine.
 *  `undefined` / `null` (no attributes) is fine too. Unknown keys are errors: a typo
 *  ("temp": 20) must not ship as a silent nothing. */
export function validateAttributes(input: unknown): string[] {
  if (input == null) return [];
  if (typeof input !== "object" || Array.isArray(input)) return ["attributes must be an object"];
  const problems: string[] = [];
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    if (!isAttributeKey(key)) {
      problems.push(`unknown attribute "${key}" (one of ${ATTRIBUTE_KEYS.join(", ")})`);
      continue;
    }
    if (v == null) {
      problems.push(`${key}: empty, omit the key instead`);
      continue;
    }
    if (isNumericKey(key)) {
      const rule = NUMERIC_RULES[key];
      if (typeof v !== "number" || !Number.isFinite(v)) problems.push(`${key}: must be a number, got ${JSON.stringify(v)}`);
      else if (v < rule.min || v > rule.max || !onStep(v, rule.step)) problems.push(`${key}: ${v} must be ${rule.why}`);
      continue;
    }
    if (typeof v !== "string" || !v.trim() || v !== v.trim() || /[,;=]/.test(v)) {
      problems.push(`${key}: must be a trimmed string without , ; or =, got ${JSON.stringify(v)}`);
      continue;
    }
    if (!STRING_FORM[key as StringKey](v)) problems.push(`${key}: "${v}" is not a canonical ${key}`);
  }
  return problems;
}

// --- CSV cell ----------------------------------------------------------------
// One column, "key=value; key=value" in ATTRIBUTE_KEYS order. Values never carry a
// comma, semicolon or equals sign (validateAttributes forbids them), so the cell needs
// no CSV quoting and a diff reads as prose: `temp_f=20; fill_power=950; length=Regular`.

/** Serialise for the CSV cell; "" when there is nothing to say. */
export function serializeAttributes(a: RowAttributes | null | undefined): string {
  if (!a) return "";
  const parts: string[] = [];
  for (const key of ATTRIBUTE_KEYS) {
    const v = a[key];
    if (v == null) continue;
    parts.push(`${key}=${v}`);
  }
  return parts.join("; ");
}

// a number as the serialiser writes it: digits, an optional sign and decimals, nothing
// Number() would also accept ("", "0x14", "2e1", " 20")
const NUMBER_FORM = /^-?\d+(?:\.\d+)?$/;

/** Parse a CSV cell back; null for a blank cell. Throws on anything malformed or
 *  non-canonical, so the seeder can never load an attribute the checks would reject. */
export function parseAttributes(cell: string | null | undefined): RowAttributes | null {
  const s = (cell ?? "").trim();
  if (!s) return null;
  const out: Record<string, string | number> = {};
  for (const part of s.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new Error(`attributes: "${part}" is not key=value`);
    const key = part.slice(0, eq);
    const raw = part.slice(eq + 1);
    if (Object.hasOwn(out, key)) throw new Error(`attributes: "${key}" given twice`);
    if (isNumericKey(key)) {
      if (!NUMBER_FORM.test(raw)) throw new Error(`attributes: ${key}=${JSON.stringify(raw)} is not a plain number`);
      out[key] = Number(raw);
    } else {
      out[key] = raw;
    }
  }
  const problems = validateAttributes(out);
  if (problems.length) throw new Error(`attributes: ${problems.join("; ")}`);
  return out as RowAttributes;
}

// --- mechanical extraction from a variant string ------------------------------

// the length scale with an optional width word and a shape word the axis model doesn't
// carry: "Regular", "Long Wide", "Regular Mummy", "M Wide", "Regular Wide Mummy"
const LENGTH_SCALE_TOKEN = new RegExp(`^(${LENGTH_WORDS}|${LETTER})(?: (Wide|Slim|Regular))?(?: Mummy)?$`);
const LENGTH_WORD_ONLY = new RegExp(`^(?:${LENGTH_WORDS})$`);
const HALF_SIZE = /^\d{1,2}(?:-\d{1,2})?$/;
const round = (n: number, places: number) => Number(n.toFixed(places));

/**
 * Read the attributes a variant string states outright. Deterministic and conservative:
 * a token is read only where its meaning is unambiguous for the gear type, a value the
 * validator would refuse is not read at all, and the first token to claim an axis keeps
 * it. A second claim on the same axis is reported through `onConflict`, whatever its
 * spelling: a contradiction ("Regular, Long") and a restatement in another scale
 * ("Medium, JP 3", "Men's US 9, EU 42", "Regular, 6ft") both fail, because a variant
 * states each axis once, in the maker's own scale (2026-09-12; until then a second
 * scale was read as the same fact and left in the variant). Runs on the NORMALISED
 * variant (the CSV form). See the file header for what it leaves.
 */
export function extractAttributes(
  variant: string | null | undefined,
  commonName: string | null | undefined,
  categoryHint: string | null | undefined,
  onConflict?: (message: string) => void,
): RowAttributes {
  const out: RowAttributes = {};
  const v = (variant ?? "").trim();
  if (!v) return out;
  const type = (commonName ?? "").trim().toLowerCase();
  const cat = (categoryHint ?? "").trim().toLowerCase();
  const traits = traitsOf(type);
  const lengthScaled = traits.lengthScaled === true;
  const pack = traits.pack === true;
  const set = <K extends AttributeKey>(key: K, value: NonNullable<RowAttributes[K]>) => {
    if (validateAttributes({ [key]: value }).length) return;
    const prev = out[key];
    if (prev === undefined) {
      out[key] = value;
    } else if (prev !== value && onConflict) {
      onConflict(`${key}: "${prev}" and "${value}"`);
    }
  };
  // a size token in any scale, after a gender or on its own: a shoe size is a size
  // anywhere; a letter is the maker's length scale on sleep gear (Zenbivy XL), the torso
  // on a pack (Zpacks M, Osprey S/M), and the size elsewhere
  const sizeToken = (s: string, afterGender: boolean): boolean => {
    if (LETTER_SIZE.test(s) || LETTER_RANGE.test(s) || SHOE_SIZE.test(s)) {
      if (SHOE_SIZE.test(s)) set("size", s);
      else if (lengthScaled) set("length", s);
      else if (pack) set("torso", s);
      else set("size", s);
      return true;
    }
    if ((afterGender || cat === "clothing") && HALF_SIZE.test(s)) {
      set("size", s);
      return true;
    }
    return false;
  };

  for (const raw of v.split(/,\s*/)) {
    // The variant says "Medium"; the axis says "M" (shared/catalogQuality, the size
    // words). Read the letter back before anything else looks at the token, so every
    // rule below sees the form it was written for. Sleep and shelter are the
    // exception: there Small / Medium / Large is a LENGTH scale the maker names in
    // words, and the length axis keeps the word.
    const dim = lengthScaled ? raw.trim() : sizeWordsToLetters(raw.trim());
    if (!dim) continue;
    let m: RegExpMatchArray | null;

    // a spaced " / " joins two spellings of ONE figure ("32oz / 1L", "20F / -6C"): read
    // the maker's metric one; or two labels for one row ("Men's US 9 / Women's US 10"),
    // which no single axis can hold: left for research
    if ((m = dim.match(/^\d+(?:\.\d+)?oz \/ (\d+(?:\.\d+)?)L$/))) {
      set("volume_l", Number(m[1]));
      continue;
    }
    if ((m = dim.match(/^(-?\d+)F \/ -?\d+C$/))) {
      set("temp_f", Number(m[1]));
      continue;
    }
    if (dim.includes(" / ")) continue;

    // gender, with or without a size after it: "Women's", "Men's M", "Women's US 8", "Men's 32"
    if ((m = dim.match(/^(Men's|Women's)(?: (.+))?$/))) {
      set("fit", m[1]);
      if (m[2]) sizeToken(m[2], true);
      continue;
    }
    // Osprey's women's fits: "WM/L", "WXS/S"
    if ((m = dim.match(/^W(XS\/S|S\/M|M\/L|L\/XL)$/))) {
      set("fit", "Women's");
      sizeToken(m[1], true);
      continue;
    }

    // temperature: "20F", "-6C"
    if ((m = dim.match(/^(-?\d+)F$/))) {
      set("temp_f", Number(m[1]));
      continue;
    }
    if ((m = dim.match(/^(-?\d+)C$/))) {
      set("temp_f", Math.round((Number(m[1]) * 9) / 5 + 32));
      continue;
    }
    // fill power: "850FP", "950+FP", "650FP down"
    if ((m = dim.match(/^(\d{3})\+?FP(?: down)?$/))) {
      set("fill_power", Number(m[1]));
      continue;
    }
    // persons: "2P", "1.5P", "2 Person", "UL2" (Big Agnes' size suffix)
    if (cat === "shelter" && (m = dim.match(/^(\d(?:\.\d)?)[Pp]$/) ?? dim.match(/^(\d) Person$/) ?? dim.match(/^UL(\d)$/))) {
      set("persons", Number(m[1]));
      continue;
    }
    // battery: "10000mAh", "20000mAh power bank"
    if ((m = dim.match(/^(\d{3,6})mAh(?: power bank)?$/))) {
      set("capacity_mah", Number(m[1]));
      continue;
    }
    // a canister's net fuel: "110g" (the "net fuel" token beside it says nothing new)
    if (type === "fuel canister" && (m = dim.match(/^(\d+)g$/))) {
      set("fuel_g", Number(m[1]));
      continue;
    }
    // torso: "M torso", "Regular torso", "17in torso", "S/M torso"
    if ((m = dim.match(/^(.+) torso$/))) {
      set("torso", m[1]);
      continue;
    }

    // volume (never on clothing, where "3L" is a fabric)
    if (cat !== "clothing") {
      if ((m = dim.match(/^(\d+(?:\.\d+)?)L(?: [A-Za-z]+)?$/))) {
        set("volume_l", Number(m[1]));
        continue;
      }
      if ((m = dim.match(/^(\d+)ml$/))) {
        set("volume_l", round(Number(m[1]) / 1000, 3));
        continue;
      }
      if ((m = dim.match(/^(\d+)qt$/))) {
        set("volume_l", round((Number(m[1]) * ML_PER_UNIT.qt) / 1000, 3));
        continue;
      }
      if ((m = dim.match(/^(\d+)gal$/))) {
        set("volume_l", round((Number(m[1]) * ML_PER_UNIT.gal) / 1000, 3));
        continue;
      }
      if (traits.container && (m = dim.match(/^(\d+(?:\.\d+)?) ?(?:fl )?oz$/))) {
        set("volume_l", round((Number(m[1]) * ML_PER_UNIT.floz) / 1000, 3));
        continue;
      }
    }

    // pad dimensions in inches: "20x72", "25 x 78" (width first, the maker's order)
    if (type === "sleeping pad" && (m = dim.match(/^(\d+) ?x ?(\d+)$/))) {
      set("width", `${m[1]}in`);
      set("length", `${m[2]}in`);
      continue;
    }
    // feet + inches, with an optional width word: "6ft", "5ft 6in", "6ft 0in", "6ft 6in Wide"
    if ((m = dim.match(/^(\d+)ft(?: (\d+)in)?(?: (Wide|Slim))?$/))) {
      set("length", m[2] && m[2] !== "0" ? `${m[1]}ft ${m[2]}in` : `${m[1]}ft`);
      if (m[3]) set("width", m[3]);
      continue;
    }
    // other measured lengths: "50ft" / "50ft hank" (cord), "120cm" / "100-120cm" (poles,
    // ice axes), "1m" (a cable), anything but clothing; bare inches only where the gear's
    // one dimension is its length, and on a sheet it's the pad width it fits
    if (cat !== "clothing" && (m = dim.match(/^(\d+ft|\d+(?:-\d+)?cm|\d+m)(?: hank)?$/))) {
      set("length", m[1]);
      continue;
    }
    if ((m = dim.match(/^(\d+(?:\.\d+)?in)$/))) {
      if (traits.lengthIn) set("length", m[1]);
      else if (traits.widthIn) set("width", m[1]);
      continue;
    }

    // sleep gear: a length scale, optionally followed by a width word; El Coyote writes
    // "Regular, Regular" (length, width); Zpacks writes "Slim-Short" (width-length)
    if (lengthScaled) {
      if ((m = dim.match(/^(Slim|Standard|Regular|Wide)-(Short|Regular|Long|Medium)$/))) {
        set("width", m[1]);
        set("length", m[2]);
        continue;
      }
      if (/^(?:Wide|Slim)$/.test(dim) || (out.length !== undefined && dim === "Regular")) {
        set("width", dim);
        continue;
      }
      if ((m = dim.match(LENGTH_SCALE_TOKEN))) {
        set("length", m[1]);
        if (m[2]) set("width", m[2]);
        continue;
      }
      continue; // "Standard" (a width for Zpacks, a length for Hammock Gear), "LW Mummy", "Double Wide": research
    }

    // packs: a bare length word is the torso
    if (pack && /^(?:Short|Regular|Long|Tall)$/.test(dim)) {
      set("torso", dim);
      continue;
    }
    // trousers: Short / Regular / Long beside a size is the inseam
    if (INSEAM_TYPE.test(type) && /^(?:Short|Regular|Long)$/.test(dim)) {
      set("length", dim);
      continue;
    }
    // the maker's own scale: "Size D", "Size 2"
    if ((m = dim.match(/^Size ([A-Z0-9]+)$/))) {
      set("size", m[1]);
      continue;
    }
    // everything else that reads as a size: letters, ranges, a shoe size, a size word
    if (sizeToken(dim, false)) continue;
    if ((WORD_SIZE.test(dim) || LENGTH_WORD_ONLY.test(dim)) && dim !== "Standard") set("size", dim);
  }
  return out;
}
