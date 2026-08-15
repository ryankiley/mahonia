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
// This file is only the LENGTH. Elevation, gradient, the per-day itinerary and the burn
// model all exist now and all live elsewhere — shared/gpx.ts reads the route's shape,
// shared/tripPlan.ts turns it into time and calories. What stays out of here is anything
// that needs more than a number and a unit.

/**
 * Metres per distance unit.
 *
 * Exported because the readouts do their own rounding — a figure under a moving cursor
 * wants a fixed width where a printed one wants its trailing zero gone — and each of them
 * was retyping 1609.344 and 0.3048 to get there. The rounding is theirs; the conversion
 * factor is one number and belongs in one place.
 */
export const M_PER_UNIT = {
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
 * A bare number is read in the caller's fallback unit (see resolveDistanceUnit),
 * which is what makes "12" mean 12 km on a km list and 12 miles elsewhere.
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

/** One of `list`'s members, or undefined for anything else — the shape every
 *  stored-enum normalizer here takes (unit fields round-trip through storage). */
function oneOf<T>(list: readonly T[], raw: unknown): T | undefined {
  return list.includes(raw as T) ? (raw as T) : undefined;
}

/** A stored distance unit, or undefined when it isn't one of the two. */
export function normalizeDistanceUnit(raw: unknown): DisplayDistanceUnit | undefined {
  return oneOf(DISPLAY_DISTANCE_UNITS, raw);
}

/**
 * The unit a list's distance actually reads in: the owner's explicit pick, else MILES.
 *
 * The fallback USED to follow the weight unit, on the reasoning that a gram list is a
 * metric list. It doesn't any more, because the two choices turned out not to travel
 * together: the app's default weight unit is grams because that's the useful unit for
 * gear, and plenty of people weigh a pack in grams and walk in miles — trail signs,
 * guidebooks and the pages people paste from all say miles for most of this app's
 * users. Having the distance flip units because someone switched to ounces was a
 * surprise rather than a convenience.
 *
 * An explicit pick still wins and is still remembered, which is the part that matters.
 */
export function resolveDistanceUnit(explicit: string | undefined): DisplayDistanceUnit {
  return normalizeDistanceUnit(explicit) ?? "mi";
}

/** A tidy label for a distance in metres: "7.5 mi", "12.1 km", "800 m". */
/**
 * The same figure with its decimal ALWAYS shown — "11.0 mi", never "11 mi".
 *
 * For distances that form a COLUMN. A whole number that drops its decimal is a character
 * narrower than the rows above and below it, so the unit slides left and the column stops
 * being a column. The day fields already pad for exactly this reason; the waypoint rows
 * sit in the same lists and have to agree.
 *
 * Separate from formatDistance rather than an option on it, because most callers want the
 * shorter reading — a sentence saying "11 mi" should not say "11.0 mi".
 */
export function formatDistancePadded(metres: number, unit: DisplayDistanceUnit): string {
  const n = metres / M_PER_UNIT[unit];
  return `${n.toFixed(1)} ${unit}`;
}

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
 * The unit a HEIGHT reads in beside a distance in `unit`: feet on a miles list, metres on
 * a kilometres one, which is how the two systems are actually spoken — nobody says "12
 * miles and 900 metres of climb".
 *
 * Here rather than in each component because four of them ask the same question (the
 * profile, the plan's chips, its day rows, and the shared view's itinerary) and a height
 * labelled "m" beside a distance in miles is the kind of disagreement one of them would
 * eventually drift into on its own.
 */
export function heightUnitFor(unit: DisplayDistanceUnit): "ft" | "m" {
  return unit === "mi" ? "ft" : "m";
}

/**
 * A height in metres as the bare number heightUnitFor asks for, grouped for reading
 * ("7,316"). The unit word is the caller's, because most of them draw it as its own
 * element in a lesser ink.
 *
 * `step` is in the DISPLAY unit and the caller's to choose: a figure printed once can be
 * exact, while one rewritten under a moving cursor has to hold still, and an editable
 * field has to round-trip through a store that only keeps metres. What must not vary is
 * the conversion, which is why that part lives here.
 */
export function heightValue(metres: number, unit: DisplayDistanceUnit, step = 1): string {
  const v = unit === "mi" ? metres / M_PER_UNIT.ft : metres;
  return (Math.round(v / step) * step).toLocaleString();
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
  return boundedRound(raw, 1, MAX_DISTANCE_M);
}

/** A route's total climb in metres. More than Everest from the sea isn't one. */
export function normalizeTrailAscentM(raw: unknown): number | undefined {
  return boundedRound(raw, 1, 30_000);
}

/** The one raw-value → stored-integer rule every normalize* above and below shares:
 *  parse a string if that's what arrived, round, and accept only [min, max]. */
function boundedRound(raw: unknown, min: number, max: number): number | undefined {
  const n = typeof raw === "string" ? Number.parseFloat(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const v = Math.round(n);
  return v >= min && v <= max ? v : undefined;
}

// ---- body weight ----
// The one input the burn model needs that a gear list doesn't already hold — and the only
// thing the app knows about a PERSON rather than about their gear.
//
// It belongs to the walker, not to a list, so it is not stored on one. It lives on the
// device (app/composables/useBodyWeight.ts), the way the vault's metric/imperial choice
// does: one setting, remembered, applying to every list you open here. That also means it
// never reaches the server at all, which is a stronger privacy claim than the fail-closed
// column it replaces — there is nothing to strip from a read path, because there is
// nothing there.
//
// Two units only; grams and ounces are absurd for a body. The stored grams never move —
// the unit is display and entry only.

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

// NOT flipped to match the distance default above: "82 kg" and "12 miles" is a normal pair
// of sentences for one person to say, where "12 km" and "180 lb" is not. So an unset body
// unit follows the weight system the device already works in, rather than the distance one.
export function bodyWeightUnitFor(displayUnit: string | undefined): BodyWeightUnit {
  return displayUnit === "oz" || displayUnit === "lb" ? "lb" : "kg";
}

export function normalizeBodyWeightUnit(raw: unknown): BodyWeightUnit | undefined {
  return oneOf(BODY_WEIGHT_UNITS, raw);
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
  return boundedRound(raw, MIN_BODY_G, MAX_BODY_G);
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

/**
 * The trip's headline distance and the unit it reads in — the figure planning mode puts
 * at the top of the page.
 *
 * Shared because TWO components need the same answer: the planning panel, which draws the
 * route beneath it, and the editor, which draws the big figure itself so that one element
 * serves all three views. Working it out twice is how the two would start to disagree,
 * and a headline that disagrees with the chart under it is worse than either number.
 *
 * The MAX, not the route alone: an itinerary can legitimately add up to more than the
 * straight-line route — a side trip, an out-and-back to water — and a figure somebody
 * typed must never be quietly discarded in favour of one read off a file.
 */
export function tripHeadline(list: {
  trailDistanceM?: number;
  trailDistanceUnit?: string;
  days?: { distanceM?: number }[];
}): { value: string; unit: DisplayDistanceUnit; metres: number } {
  const unit = resolveDistanceUnit(list.trailDistanceUnit);
  const typed = (list.days ?? []).reduce((s, d) => s + (d?.distanceM ?? 0), 0);
  const metres = Math.max(list.trailDistanceM ?? 0, typed);
  // Bare number to one decimal, never a unit switch: formatDistance drops below a
  // kilometre to metres, which is right in prose and wrong beside the headline's
  // own unit control still saying "km".
  return { value: String(Number((metres / M_PER_UNIT[unit]).toFixed(1))), unit, metres };
}
