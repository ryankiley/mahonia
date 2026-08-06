// Trail distance — how far the route in the trail link actually goes.
//
// TYPED, never fetched. The obvious alternative — read it off the linked page — is
// the same dead end trailLink.ts documents for names: alltrails.com answers a
// server-side GET with 403 whatever user-agent you send, its robots.txt disallows
// `//api/`, and there is no public API to ask instead. A slug carries a name; it
// never carries a distance. So the number comes from the one source that always
// has it — the person who just read it off the page they linked.
//
// Stored in METRES, the way weight is stored in milligrams: one canonical unit, the
// entry unit is a display concern. Distance is a property of the ROUTE, so it lives
// on the trail link rather than on the list — clearing the link clears it too.
//
// This is not the first step of a trip planner. There is no elevation, no gradient,
// no per-day itinerary, and deliberately no burn model: see the note in
// shared/foodPlan.ts for why the arithmetic stops where it does.

/** Metres per distance unit. */
const M_PER_UNIT = {
  m: 1,
  km: 1000,
  mi: 1609.344,
  ft: 0.3048,
} as const;

/** Every unit the PARSER understands — "800 m" and "2000 ft" are things people type. */
export type DistanceUnit = keyof typeof M_PER_UNIT;

/**
 * The units a list can be SET to. Only two, because this is the choice "which system
 * does this trip read in", not "which of four units". Metres and feet stay typeable —
 * a 900 m approach is a real thing to enter — they're just not a mode a whole list
 * sits in, and offering them as one would mean a list that renders a 12 km hike as
 * "12000 m".
 */
export const DISPLAY_DISTANCE_UNITS = ["km", "mi"] as const;
export type DisplayDistanceUnit = (typeof DISPLAY_DISTANCE_UNITS)[number];

// The stored bound, applied INSIDE the parser for the same reason trailLink.ts
// clamps there: this is the only limit there is. 10,000 km is longer than the
// longest thru-hike on earth and still nowhere near a float that misbehaves.
const MAX_DISTANCE_M = 10_000_000;

/** One unit word → its metres, or null when the word isn't a unit we know. */
function unitFromToken(token: string): number | null {
  const u = token.replace(/[. ]/g, "");
  if (u === "km" || u === "kms" || u.startsWith("kilomet")) return M_PER_UNIT.km;
  if (u === "m" || u === "mtr" || u.startsWith("met")) return M_PER_UNIT.m;
  // "mi"/"mile"/"miles" only — a bare "m" is metres, and guessing miles from it
  // would silently multiply a route by 1609.
  if (u === "mi" || u.startsWith("mile")) return M_PER_UNIT.mi;
  if (u === "ft" || u === "feet" || u === "foot") return M_PER_UNIT.ft;
  return null;
}

/**
 * A number token → its value, resolving the comma.
 *
 * This is the one genuinely ambiguous character in a pasted stats line: "3,159 ft"
 * means three thousand, "12,5 km" means twelve and a half, and the old code's blanket
 * `.replace(",", ".")` read the first as 3.159. It never showed because the field was
 * anchored and people typed simple values; a paste puts both in the same string.
 *
 *   a dot is present   → the comma can only be a thousands separator
 *   groups of three    → thousands ("1,234", "1,234,567", and "12 000")
 *   anything else      → a decimal comma, the European form
 *
 * A SPACE groups thousands too ("12 000 m"), which is why it's read here rather than
 * treated as the end of the number: taken as a terminator, "12 000 m" parsed as a
 * bare "12" and became twelve MILES on an imperial list, and "1 234 km" quietly threw
 * the leading 1 away. Only exact groups of three join, so "5 10" stays two numbers.
 */
function parseNumberToken(token: string): number {
  const t = token.trim();
  if (t.includes(".")) return Number.parseFloat(t.replace(/[, ]/g, ""));
  if (/^\d{1,3}(?:[, ]\d{3})+$/.test(t)) return Number.parseFloat(t.replace(/[, ]/g, ""));
  return Number.parseFloat(t.replace(",", "."));
}

type Candidate = { metres: number; unit: DistanceUnit | null };

/**
 * Parse a human distance into metres. Takes what someone TYPES ("7.5", "7.5 mi",
 * "12km", "12,5 km") and also what they PASTE off the page they linked
 * ("Length: 7.5 mi", "7.5 mi • 3,159 ft • Out & back"), because the number is on
 * that page and retyping it is the step worth removing.
 *
 * A bare number is read in the unit the list displays (see distanceUnitFor), which
 * is what makes "12" mean 12 km on a gram list and 12 miles on an ounce one.
 *
 * WHICH number, when a paste holds several: a stats line pairs a LENGTH in km/mi with
 * a GAIN in m/ft, so a lone km/mi candidate is the length whatever order they came in
 * — that's what makes "7.5 mi • 3,159 ft" and "3,159 ft • 7.5 mi" both read 7.5 mi.
 * Failing that it takes the first, and a number qualified by a word that ISN'T a unit
 * ("10 furlongs") is rejected outright rather than quietly read as a bare number.
 *
 * Returns null for anything unparseable, non-positive, or past the bound.
 */
export function parseDistanceM(raw: string, fallbackUnit: DistanceUnit = "km"): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  const candidates: Candidate[] = [];
  // number, then the word attached to it if there is one
  // grouped-thousands form FIRST, so "12 000" is one number rather than "12" and a
  // stray "000" (see parseNumberToken)
  const scan = /(\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?|\d[\d,]*(?:\.\d+)?|\.\d+)\s*([a-z]+)?/g;
  for (let m = scan.exec(s); m; m = scan.exec(s)) {
    // A leading minus belongs to the number, and a negative distance is not one.
    // Checked from the source rather than captured, so "7.5 mi • -3 ft" still works.
    if (s[m.index - 1] === "-") continue;
    const value = parseNumberToken(m[1]!);
    if (!Number.isFinite(value) || value <= 0) continue;
    const word = m[2];
    if (!word) {
      candidates.push({ metres: value * M_PER_UNIT[fallbackUnit], unit: null });
      continue;
    }
    const perM = unitFromToken(word);
    // qualified by something we don't understand — decline this candidate rather than
    // pretend the qualifier wasn't there
    if (perM == null) continue;
    candidates.push({
      metres: value * perM,
      unit: perM === M_PER_UNIT.km ? "km" : perM === M_PER_UNIT.mi ? "mi" : perM === M_PER_UNIT.ft ? "ft" : "m",
    });
  }
  if (!candidates.length) return null;

  const routeScale = candidates.filter((c) => c.unit === "km" || c.unit === "mi");
  const chosen = routeScale.length === 1 ? routeScale[0]! : candidates[0]!;

  const metres = Math.round(chosen.metres);
  return metres > 0 && metres <= MAX_DISTANCE_M ? metres : null;
}

/**
 * The distance unit implied by the weight unit a list already shows. A list in grams
 * is a metric list; a list in ounces is not. This is the DEFAULT, not the answer —
 * see resolveDistanceUnit.
 */
export function distanceUnitFor(displayUnit: string): DisplayDistanceUnit {
  return displayUnit === "oz" || displayUnit === "lb" ? "mi" : "km";
}

/** A stored distance unit, or undefined when it isn't one of the two. */
export function normalizeDistanceUnit(raw: unknown): DisplayDistanceUnit | undefined {
  return DISPLAY_DISTANCE_UNITS.includes(raw as DisplayDistanceUnit)
    ? (raw as DisplayDistanceUnit)
    : undefined;
}

/**
 * The unit a list's distance actually reads in: the owner's explicit pick, else the
 * one the weight unit implies.
 *
 * Absent means "follow the weight unit", which is exactly how the field behaved
 * before it was pickable — the same shape Item.entryUnit uses against displayUnit,
 * and for the same reason. It also keeps the two honest cases apart: a metric list
 * whose owner has never thought about distance FOLLOWS the weight unit when they
 * later switch to ounces, while one who deliberately chose km stays in km.
 */
export function resolveDistanceUnit(
  explicit: string | undefined,
  displayUnit: string,
): DisplayDistanceUnit {
  return normalizeDistanceUnit(explicit) ?? distanceUnitFor(displayUnit);
}

/** A tidy label for a distance in metres: "7.5 mi", "12.1 km", "800 m". */
export function formatDistance(metres: number, unit: DisplayDistanceUnit): string {
  if (unit === "mi") {
    return `${Number.parseFloat((metres / M_PER_UNIT.mi).toFixed(1))} mi`;
  }
  // Under a kilometre, kilometres read as "0.4 km" — true, but metres are what a
  // sign at the trailhead would say.
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${Number.parseFloat((metres / M_PER_UNIT.km).toFixed(1))} km`;
}

/**
 * The stored distance as the bare number its input shows ("7.5"), or "" at zero —
 * the round-trip partner of parseDistanceM, mirroring waterLiters in water.ts.
 */
export function distanceFieldValue(metres: number | undefined, unit: DisplayDistanceUnit): string {
  if (!metres || metres <= 0) return "";
  return String(Number((metres / M_PER_UNIT[unit]).toFixed(2)));
}

/**
 * A raw distance value → its stored form, or undefined when it's blank or unusable.
 * Every write path stores THIS, so what's persisted is already clamped and already
 * a positive integer count of metres (the reducer and the create endpoint agree,
 * exactly as they do for trailUrl).
 */
export function normalizeTrailDistanceM(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number.parseFloat(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const metres = Math.round(n);
  return metres > 0 && metres <= MAX_DISTANCE_M ? metres : undefined;
}

// ---- body weight ----
// The one input the burn model needs that a gear list doesn't already hold. Same three
// rules as the distance unit above, for the same reasons: only two units offered (grams
// and ounces are absurd for a body), absent follows the list's own weight unit, and the
// stored grams never move — the unit is display and entry only.

export const BODY_WEIGHT_UNITS = ["kg", "lb"] as const;
export type BodyWeightUnit = (typeof BODY_WEIGHT_UNITS)[number];

const G_PER_BODY_UNIT = { kg: 1000, lb: 453.59237 } as const;

// 70 kg, the figure the load-carriage literature is usually stated against. It is a
// STATED assumption, never a silent one: the UI says "assuming 70 kg" until someone
// sets their own, because a pre-filled field looks like something you confirmed.
export const DEFAULT_BODY_G = 70_000;
// Bounds, not opinions: past these it isn't a person, and the model's validated range is
// nowhere near either end.
const MIN_BODY_G = 20_000;
const MAX_BODY_G = 400_000;

export function bodyWeightUnitFor(displayUnit: string): BodyWeightUnit {
  return displayUnit === "oz" || displayUnit === "lb" ? "lb" : "kg";
}

export function normalizeBodyWeightUnit(raw: unknown): BodyWeightUnit | undefined {
  return BODY_WEIGHT_UNITS.includes(raw as BodyWeightUnit) ? (raw as BodyWeightUnit) : undefined;
}

export function resolveBodyWeightUnit(explicit: string | undefined, displayUnit: string): BodyWeightUnit {
  return normalizeBodyWeightUnit(explicit) ?? bodyWeightUnitFor(displayUnit);
}

/** A raw body weight → grams, or undefined. Bare numbers read in the given unit. */
export function parseBodyWeightG(raw: string, fallbackUnit: BodyWeightUnit): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(",", ".");
  const m = s.match(/^(\d*\.?\d+)\s*([a-z. ]*)$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[2]!.replace(/[. ]/g, "");
  let perG: number | undefined;
  if (u === "") perG = G_PER_BODY_UNIT[fallbackUnit];
  else if (u === "kg" || u.startsWith("kilo")) perG = G_PER_BODY_UNIT.kg;
  else if (u === "lb" || u === "lbs" || u.startsWith("pound")) perG = G_PER_BODY_UNIT.lb;
  else return null;
  const grams = Math.round(n * perG);
  return grams >= MIN_BODY_G && grams <= MAX_BODY_G ? grams : null;
}

export function normalizeBodyWeightG(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number.parseFloat(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const g = Math.round(n);
  return g >= MIN_BODY_G && g <= MAX_BODY_G ? g : undefined;
}

/** "70 kg" / "154 lb" — one canonical number rendered in whichever unit is in play. */
export function formatBodyWeight(grams: number, unit: BodyWeightUnit): string {
  const n = grams / G_PER_BODY_UNIT[unit];
  return `${Math.round(n)} ${unit}`;
}

/** The bare number an input shows, the round-trip partner of parseBodyWeightG. */
export function bodyWeightFieldValue(grams: number | undefined, unit: BodyWeightUnit): string {
  if (!grams) return "";
  return String(Math.round(grams / G_PER_BODY_UNIT[unit]));
}
