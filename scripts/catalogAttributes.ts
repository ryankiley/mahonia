// Typed attributes on a catalog row — the axes a variant string has always crammed into
// prose. "20F, 950FP, Regular" is a temperature, a fill power and a length; "Men's US 9"
// is a fit and a size; "65L" is a volume. A research row carries them as an `attributes`
// object beside its variant, the build serialises them into one CSV column, and the
// checks hold them to units (here) and to the variant text (scripts/catalogChecks.ts).
//
// Two halves, both pure:
//   • validateAttributes — the unit rules. Every value has one canonical form, so a
//     row can't say "20°F" here and "20F" there, or store a fill power as "850fp".
//   • extractAttributes — the MECHANICAL reading of a variant string, keyed on the gear
//     type where a token is ambiguous ("Regular" is a length on a quilt, a torso on a
//     pack, an inseam on pants, a size on a pillow). The first pass over the catalog
//     was this function; the CSV check re-runs it on every row, so a variant that
//     states "20F" with no `temp_f: 20` beside it fails the build — the same way a
//     "6 ft" that isn't "6ft" does. Everything it does NOT read (a bare "Standard"
//     that is a width on a Zpacks quilt and a length on a Hammock Gear one, "LW Mummy",
//     "Double Wide") is left for research, which writes the attribute by hand.
//
// Build-time only (scripts/), like catalogChecks and gearTypes: the runtime reads the
// seeded column, it never re-derives these.

export interface RowAttributes {
  /** "Men's" | "Women's" | "Unisex" | "Kids" — the gendered version, never a size. */
  fit?: string;
  /** A letter ("M", "XL", "S/M", "M+"), a footwear size with its region ("US 9",
   *  "UK 8", "EU 42", "JP 3"), a size word the maker uses ("Regular", "Jumbo"), or the
   *  maker's own scale ("4", "3-4", "D", "32"). Sleep + shelter lengths go in `length`. */
  size?: string;
  /** Pack torso: a letter, a range ("S/M"), a word ("Regular"), or inches ("17in"). */
  torso?: string;
  /** A length word ("Short", "Regular", "Long", "Tall", "Petite", "Small", "Large",
   *  "X-Large", or a letter where the maker's length scale is letters) or a measurement
   *  ("6ft", "6ft 6in", "72in", "120cm", "100-120cm", "1m"). */
  length?: string;
  /** "Slim" | "Standard" | "Regular" | "Wide" | "Extra Wide" or inches / cm. */
  width?: string;
  /** Temperature rating in °F (integer). A Celsius-only rating is converted. */
  temp_f?: number;
  /** Down fill power (500–1000). */
  fill_power?: number;
  /** Sleeping-pad R-value (0.5–15, one decimal). */
  r_value?: number;
  /** Shelter capacity in people (1–8, halves allowed: a 1.5P tent). */
  persons?: number;
  /** Volume in litres (up to three decimals: 500ml is 0.5, 525ml is 0.525). */
  volume_l?: number;
  /** Battery capacity in mAh. */
  capacity_mah?: number;
  /** A fuel canister's net fuel, grams (the stored weight IS the gas). */
  fuel_g?: number;
  /** Stove / canister fuel type. */
  fuel?: string;
}

/** Column order in the CSV cell and the canonical key order in research JSON. */
export const ATTRIBUTE_KEYS = [
  "fit",
  "size",
  "torso",
  "length",
  "width",
  "temp_f",
  "fill_power",
  "r_value",
  "persons",
  "volume_l",
  "capacity_mah",
  "fuel_g",
  "fuel",
] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

const NUMERIC_KEYS = new Set<AttributeKey>(["temp_f", "fill_power", "r_value", "persons", "volume_l", "capacity_mah", "fuel_g"]);

// --- canonical forms ---------------------------------------------------------

const LETTER = "XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL";
const LETTER_SIZE = new RegExp(`^(?:${LETTER})\\+?$`);
const LETTER_RANGE = new RegExp(`^(?:${LETTER})/(?:${LETTER})$`);
const SHOE_SIZE = /^(?:US|UK|EU|JP) \d{1,2}(?:\.5)?$/;
// size words a maker sells several of, outside the S/M/L family (which is letters)
const WORD_SIZE = /^(?:X-Small|Small|Medium|Large|X-Large|Regular|Short|Long|Tall|Wide|Slim|Mini|Jumbo|Big|Nano|Petite|Standard)$/;
// the maker's own scale: Gnuhr "4" / "3-4", Superfeet "D", a waist "32"
const SCALE_SIZE = /^(?:\d{1,2}(?:-\d{1,2})?|[A-Z])$/;
const LENGTH_WORD = new RegExp(`^(?:Short|Regular|Long|Tall|Petite|Small|Medium|Large|X-Large|Standard|${LETTER})$`);
const LENGTH_MEASURE = /^(?:\d+ft(?: [1-9]\d?in)?|\d+(?:\.\d+)?in|\d+(?:-\d+)?cm|\d+(?:\.\d+)?m)$/;
const WIDTH_FORM = /^(?:Slim|Standard|Regular|Wide|Extra Wide|\d+(?:\.\d+)?in|\d+cm)$/;
const TORSO_FORM = new RegExp(`^(?:${LETTER}|(?:${LETTER})/(?:${LETTER})|Short|Regular|Long|Tall|\\d+(?:\\.\\d+)?in|\\d+-\\d+in)$`);
const FIT_FORM = /^(?:Men's|Women's|Unisex|Kids)$/;
const FUEL_FORM = /^(?:isobutane|butane|propane|alcohol|solid fuel|wood|white gas)$/;

const isSizeForm = (s: string) => LETTER_SIZE.test(s) || LETTER_RANGE.test(s) || SHOE_SIZE.test(s) || WORD_SIZE.test(s) || SCALE_SIZE.test(s);

const decimals = (n: number) => {
  const s = String(n);
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
};

/** Every way a row's attributes can be wrong, as messages; `[]` when they're fine.
 *  `undefined` / `null` (no attributes) is fine too. Unknown keys are errors — a typo
 *  ("temp": 20) must not ship as a silent nothing. */
export function validateAttributes(input: unknown): string[] {
  if (input == null) return [];
  if (typeof input !== "object" || Array.isArray(input)) return ["attributes must be an object"];
  const problems: string[] = [];
  const a = input as Record<string, unknown>;
  for (const key of Object.keys(a)) {
    if (!(ATTRIBUTE_KEYS as readonly string[]).includes(key)) {
      problems.push(`unknown attribute "${key}" (one of ${ATTRIBUTE_KEYS.join(", ")})`);
      continue;
    }
    const v = a[key];
    if (v == null) {
      problems.push(`${key}: empty — omit the key instead`);
      continue;
    }
    if (NUMERIC_KEYS.has(key as AttributeKey)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        problems.push(`${key}: must be a number, got ${JSON.stringify(v)}`);
        continue;
      }
      const bad = (why: string) => problems.push(`${key}: ${v} ${why}`);
      switch (key as AttributeKey) {
        case "temp_f":
          if (!Number.isInteger(v) || v < -60 || v > 80) bad("must be a whole °F between -60 and 80");
          break;
        case "fill_power":
          if (!Number.isInteger(v) || v < 500 || v > 1000) bad("must be a whole fill power between 500 and 1000");
          break;
        case "r_value":
          if (v < 0.5 || v > 15 || decimals(v) > 1) bad("must be an R-value between 0.5 and 15 with at most one decimal");
          break;
        case "persons":
          if (v < 1 || v > 8 || (v * 2) % 1 !== 0) bad("must be 1–8 people, in halves");
          break;
        case "volume_l":
          if (v <= 0 || v > 500 || decimals(v) > 3) bad("must be litres, 0 < v ≤ 500, at most three decimals");
          break;
        case "capacity_mah":
          if (!Number.isInteger(v) || v < 500 || v > 200_000) bad("must be whole mAh between 500 and 200000");
          break;
        case "fuel_g":
          if (!Number.isInteger(v) || v < 50 || v > 1000) bad("must be whole grams between 50 and 1000");
          break;
      }
      continue;
    }
    if (typeof v !== "string" || !v.trim() || v !== v.trim() || /[,;=]/.test(v)) {
      problems.push(`${key}: must be a trimmed string without , ; or =, got ${JSON.stringify(v)}`);
      continue;
    }
    const form: Record<string, RegExp> = { fit: FIT_FORM, torso: TORSO_FORM, width: WIDTH_FORM, fuel: FUEL_FORM };
    const ok =
      key === "size" ? isSizeForm(v) : key === "length" ? LENGTH_WORD.test(v) || LENGTH_MEASURE.test(v) : form[key]!.test(v);
    if (!ok) problems.push(`${key}: "${v}" is not a canonical ${key}`);
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
    if (key in out) throw new Error(`attributes: "${key}" given twice`);
    out[key] = NUMERIC_KEYS.has(key as AttributeKey) ? Number(raw) : raw;
  }
  const problems = validateAttributes(out);
  if (problems.length) throw new Error(`attributes: ${problems.join("; ")}`);
  return out as RowAttributes;
}

/** Canonical key order for research JSON, so a hand-written object and a scripted one
 *  serialise the same way. Drops nothing, validates nothing. */
export function orderAttributes(a: RowAttributes): RowAttributes {
  const out: Record<string, unknown> = {};
  for (const key of ATTRIBUTE_KEYS) if (a[key] != null) out[key] = a[key];
  return out as RowAttributes;
}

// --- mechanical extraction from a variant string ------------------------------

// Where Small / Regular / Long (and a maker's letters) are a LENGTH scale.
const LENGTH_SCALED = new Set(["quilt", "sleeping bag", "sleeping pad", "bivy", "sleeping bag liner", "hammock", "foam pad"]);
// Where a bare Short / Regular / Tall is the torso.
const PACK_TYPES = new Set(["backpack", "fastpack", "daypack"]);
// Where Short / Regular / Long beside a letter size is the inseam.
const INSEAM_TYPE = /\b(?:pants|leggings|tights|bottoms)$/;
// Where "16oz" is fluid ounces, not a net weight (a 2oz balm, a 1.75oz snack).
const CONTAINER_TYPES = new Set([
  "jar", "squeeze bottle", "water bottle", "soft flask", "water treatment", "cup", "pot", "kettle", "dropper bottle",
  "spray bottle", "toiletry bottle", "insect repellent", "water filter", "flask", "bottle",
]);
// Where a bare "6in" is a length (not a stool's height or a ball's diameter).
const LENGTH_IN_TYPES = new Set([
  "tent stakes", "straps", "strap", "rubber bands", "straw", "tent poles", "shoulder straps", "snowshoes", "cord",
  "paracord", "guyline", "ridgeline", "trekking poles", "ice axe", "charging cable",
]);

const OZ_TO_L = 0.0295735;
const round = (n: number, places: number) => Number(n.toFixed(places));

/**
 * Read the attributes a variant string states outright. Deterministic and conservative:
 * a token is read only where its meaning is unambiguous for the gear type, and the first
 * token to claim an axis keeps it ("M, JP 3" is size M; the JP 3 stays in the variant).
 * Runs on the NORMALISED variant (the CSV form). See the file header for what it leaves.
 */
export function extractAttributes(variant: string | null | undefined, commonName: string | null | undefined, categoryHint: string | null | undefined): RowAttributes {
  const out: RowAttributes = {};
  const v = (variant ?? "").trim();
  if (!v) return out;
  const type = (commonName ?? "").trim().toLowerCase();
  const cat = (categoryHint ?? "").trim().toLowerCase();
  const lengthScaled = LENGTH_SCALED.has(type);
  const set = <K extends AttributeKey>(key: K, value: RowAttributes[K]) => {
    if (out[key] === undefined) out[key] = value;
  };
  // a size token in any scale, after a gender or on its own; on sleep gear a plain
  // letter is the maker's length scale (Zenbivy Regular / Large / XL)
  const sizeToken = (s: string, afterGender: boolean): boolean => {
    if (LETTER_SIZE.test(s) || LETTER_RANGE.test(s) || SHOE_SIZE.test(s)) {
      if (lengthScaled && /^(?:XXS|XS|S|M|L|XL|XXL)$/.test(s)) set("length", s);
      else set("size", s);
      return true;
    }
    if ((afterGender || cat === "clothing") && /^\d{1,2}(?:-\d{1,2})?$/.test(s)) {
      set("size", s);
      return true;
    }
    return false;
  };

  for (const raw of v.split(/,\s*/)) {
    const dim = raw.trim();
    if (!dim) continue;
    let m: RegExpMatchArray | null;

    // a spaced " / " joins two spellings of ONE figure ("32oz / 1L", "20F / -6C") — read
    // the maker's metric one — or two labels for one row ("Men's US 9 / Women's US 10"),
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
      set("size", m[1]);
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
    if ((m = dim.match(/^(.+) torso$/)) && TORSO_FORM.test(m[1])) {
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
        set("volume_l", round(Number(m[1]) * 0.946353, 3));
        continue;
      }
      if ((m = dim.match(/^(\d+)gal$/))) {
        set("volume_l", round(Number(m[1]) * 3.78541, 3));
        continue;
      }
      if (CONTAINER_TYPES.has(type) && (m = dim.match(/^(\d+(?:\.\d+)?) ?(?:fl )?oz$/))) {
        set("volume_l", round(Number(m[1]) * OZ_TO_L, 3));
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
    // ice axes), "1m" (a cable) — anything but clothing; bare inches only where the gear's
    // one dimension is its length, and on a sheet it's the pad width it fits
    if (cat !== "clothing" && (m = dim.match(/^(\d+ft|\d+(?:-\d+)?cm|\d+m)(?: hank)?$/))) {
      set("length", m[1]);
      continue;
    }
    if ((m = dim.match(/^(\d+(?:\.\d+)?in)$/))) {
      if (LENGTH_IN_TYPES.has(type)) set("length", m[1]);
      else if (type === "sheet") set("width", m[1]);
      continue;
    }

    // sleep + shelter: a length scale, optionally followed by a width word, and a
    // shape word the axis model doesn't carry: "Regular", "Long Wide", "Regular Mummy",
    // "M Wide", "Regular Wide Mummy"; El Coyote writes "Regular, Regular" (length, width)
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
      if ((m = dim.match(new RegExp(`^(Short|Regular|Long|Tall|Petite|Small|Medium|Large|X-Large|${LETTER})(?: (Wide|Slim|Regular))?(?: Mummy)?$`)))) {
        set("length", m[1]);
        if (m[2]) set("width", m[2]);
        continue;
      }
      continue; // "Standard" (a width for Zpacks, a length for Hammock Gear), "LW Mummy", "Double Wide": research
    }

    // packs: a bare length word is the torso
    if (PACK_TYPES.has(type) && /^(?:Short|Regular|Long|Tall)$/.test(dim)) {
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
    if (WORD_SIZE.test(dim) && dim !== "Standard") set("size", dim);
  }
  return out;
}
