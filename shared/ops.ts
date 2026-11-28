// Mutation operations — the SINGLE source of truth for how a list changes.
// The same reducer runs on the client (optimistic) and the server
// (authoritative), so the two states can never drift. Ops are designed to
// MERGE: two editors adding different items both succeed with no conflict; the
// version counter only signals "you're behind, refetch", not "rejected".

import { isRecord } from "./record";
import { isCalendarDate } from "./calendar";
import { parseProfile } from "./profile";
import { tidyProse, tidyText } from "./tidyText";
import { boundedRound, normalizeDistanceUnit, normalizeTrailAscentM, normalizeTrailDistanceM } from "./trailDistance";
import { MAX_URL_LEN, normalizeTrailLabel, normalizeTrailUrl, safeUrl } from "./trailLink";
import type { Classification, Folder, Item, ListMeta, ListMetaKey, ListSnapshot, ListState, Person, TripDay, Unit, Waypoint } from "./types";
import { CLASSIFICATIONS, UNITS, WAYPOINT_KINDS } from "./types";
import { MAX_PERSON_NAME_LEN, personNameTaken, UNASSIGNED } from "./people";
import { isWaterName } from "./water";
import { cumulativeM, decodePolyline, isLoop, normalizeRouteGeometry } from "./polyline";

// updateItem's patch: Partial<Item> plus `catalogItemId: null` as an explicit
// "unlink" — a free rename turns a linked item into a custom one, and the old
// product's link must not survive the rename (it would keep feeding the
// weight-drift nudge from a product the user no longer has).
// folderId is excluded: moveItem is the SOLE folder-changing op — it validates the
// target folder against the list and keeps nested children's folderId in sync,
// neither of which a bare field patch can do (cleanItemPatch can't see the list).
// entryUnit, kcal and personId join catalogItemId in taking an explicit null: all
// are optional fields the user can turn back OFF, and `undefined` can't express
// that through a JSON body (it simply vanishes), so null is the wire's way to say
// "clear this" as distinct from "leave it alone".
export type ItemPatch = Omit<Partial<Item>, "catalogItemId" | "folderId" | "entryUnit" | "kcal" | "personId"> & {
  catalogItemId?: number | null;
  entryUnit?: Unit | null;
  kcal?: number | null;
  personId?: string | null;
};

// `quiet` marks an op the EDITOR performed on your behalf rather than one you'd say
// you did: a blank row tidying itself away on blur, a nesting container dissolving
// as its name moves onto its child, a row being indented. The reducer ignores it
// entirely — it changes no state and carries no capability — and the change summary
// skips it, so the history reads as gestures a person made.
//
// It's on the wire because the summary is derived SERVER-side, and the server cannot
// tell these apart from the op alone: all three arrive as `{ t: "removeItem", id }`.
// Both tests you'd reach for collide — "the row had no content" misses the container
// (it carries the gear's name), and "the row had children" catches a deliberate
// delete of a parent, which cascades. The client knows which gesture it was; nothing
// else can.
export type Op =
  | { t: "addItem"; item: Item }
  | { t: "updateItem"; id: string; patch: ItemPatch }
  | { t: "removeItem"; id: string; quiet?: true }
  // moveItem reorders + reparents in one op. parentId: undefined = leave nesting as-is
  // (a plain reorder); null = top-level; a string = nest under that item.
  | { t: "moveItem"; id: string; folderId: string | null; sortOrder: number; parentId?: string | null; quiet?: true }
  | { t: "addFolder"; folder: Folder }
  | { t: "updateFolder"; id: string; patch: Partial<Folder> }
  | { t: "removeFolder"; id: string }
  // Days follow the FOLDER ops, not the item ones: three, with reorder riding as a
  // sortOrder patch on updateDay. There is no moveDay for the same reason there is no
  // moveFolder — a day has no container to move between, only an order.
  | { t: "addDay"; day: TripDay }
  | { t: "updateDay"; id: string; patch: DayPatch }
  | { t: "removeDay"; id: string }
  // Waypoints follow the day ops exactly. No moveWaypoint and no sortOrder patch: a
  // waypoint's position on the route IS its order, so there is nothing to reorder.
  | { t: "addWaypoint"; waypoint: Waypoint }
  | { t: "updateWaypoint"; id: string; patch: Partial<Waypoint> }
  | { t: "removeWaypoint"; id: string }
  // People follow the day ops too: three, reorder riding as a sortOrder patch.
  // removePerson is the one with a cascade — see its case.
  | { t: "addPerson"; person: Person }
  | { t: "updatePerson"; id: string; patch: Partial<Person> }
  | { t: "removePerson"; id: string }
  | {
      t: "setMeta";
      patch: Partial<{
        title: string;
        description: string;
        displayUnit: Unit;
        trailUrl: string;
        trailLabel: string;
        // metres, or "" to clear — the empty string is how every clearable meta field
        // here says "remove", and a number channel alone couldn't express it
        trailDistanceM: number | string;
        trailDistanceUnit: string;
        trailProfile: string;
        // the encoded polyline, or "" to clear — same sentinel as trailProfile above
        routeGeometry: string;
        trailAscentM: number | string;
        trailDescentM: number | string;
        startDate: string;
        endDate: string;
      }>;
    };

// `YYYY-MM-DD`, and a date that actually exists — the regex alone would accept
// 2026-02-31, which Date normalises to March and would silently move the trip.

/**
 * A trip date, or nothing.
 *
 * Exported because a date reaches storage two ways — through a `setMeta` op on a
 * saved list, and in the body of `POST /api/lists/create` when a DRAFT that already
 * has dates is first saved (or a JSON backup is restored). Those are different code
 * paths on different sides of the wire, and they have to agree on what a date is;
 * one rule, written once, is how they do.
 */
export function normalizeCalendarDate(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  // shared/calendar.ts owns what a date is — the same rule the display side reads by
  return isCalendarDate(value) ? value : undefined;
}

/**
 * One rule for every clearable meta field: set what the normalizer gives back, else
 * DELETE the key. Absent — not blank, not zero — is how each of these says "unset",
 * so a re-read or restored state matches a never-set one exactly.
 */
function setOrClear<K extends ClearableMetaKey>(state: ListMeta, key: K, value: ListMeta[K] | undefined): void {
  if (value) state[key] = value;
  else delete state[key];
}

/** Every meta field setMeta can CLEAR with "" — all of them but the four that always
 *  hold something (a title, a description, a unit, a URL that keeps a stale value over
 *  a hostile one). Derived, so a field added to LIST_META_KEYS reaches here on its own. */
type ClearableMetaKey = Exclude<ListMetaKey, "title" | "description" | "displayUnit" | "trailUrl">;

/**
 * The setOrClear fields, each with the normalizer that is its single gate — the
 * WHY for each rule sits on its row. `numeric` rows also accept a number on the wire
 * (metres); the rest take strings only, so a malformed op carrying a number into a
 * string field is ignored rather than coerced. trailUrl and routeGeometry are not
 * here: the URL keeps a stale value over a hostile one, and the geometry reseeds the
 * waypoints — both live in the setMeta case itself.
 */
const META_RULES: {
  [K in Exclude<ClearableMetaKey, "routeGeometry">]: {
    numeric?: true;
    normalize: (raw: string | number) => ListMeta[K] | undefined;
  };
} = {
  trailLabel: { normalize: (raw) => normalizeTrailLabel(String(raw)) },
  // Metres, bounded and integer-ised by the normalizer. Anything that isn't a
  // usable distance CLEARS, on the same reasoning as the dates below: a route
  // length of "0" or "abc" is not a partially-valid state worth carrying.
  trailDistanceM: { numeric: true, normalize: normalizeTrailDistanceM },
  // Anything that isn't one of the two units clears back to ABSENT, which means
  // "follow the weight unit" — the default, not a blank: the default is stored by
  // not being stored.
  trailDistanceUnit: { normalize: normalizeDistanceUnit },
  // Same clear-on-unusable rule as everything else here. Note this rides the ordinary
  // op pipeline: it is list state for the OWNER, and only the read paths strip it.
  // parseProfile is the single gate: a hand-edited value, a truncated string or
  // anything that isn't elevations in metres clears rather than persisting.
  trailProfile: {
    normalize: (raw) => {
      const prof = parseProfile(raw);
      return prof.length ? prof.join(",") : undefined;
    },
  },
  trailAscentM: { numeric: true, normalize: normalizeTrailAscentM },
  trailDescentM: { numeric: true, normalize: normalizeTrailAscentM },
  // Dates are SHAPE-checked, not just clamped. They're rendered and exported, and
  // a half-typed "2026-0" would otherwise persist and read as a real date
  // everywhere downstream. Anything that isn't a real date CLEARS rather than
  // persists — an unparseable value is a date nobody can act on, and leaving the
  // old one would be a lie.
  startDate: { normalize: normalizeCalendarDate },
  endDate: { normalize: normalizeCalendarDate },
};
/** Every META_RULES field, each one present: its stored value, or undefined. */
type MetaFields = { [K in keyof typeof META_RULES]: ListMeta[K] | undefined };

/**
 * The clearable meta fields of a foreign object, each as the reducer's setMeta would
 * store it (undefined = clear, or nothing usable there). EVERY key comes back, the
 * unusable ones as undefined: a whole-list write spreads this, and an update that
 * leaves a column out keeps the live value standing. The JSON importer re-validates a
 * hand-edited backup by this, and the server's create and restore validate by it too:
 * the same eight rules, not a second list of them.
 */
export function normalizeMetaFields(raw: Record<string, unknown>): MetaFields {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(META_RULES) as (keyof typeof META_RULES)[]) {
    const v = raw[key];
    const rule = META_RULES[key];
    out[key] = typeof v === "string" || (rule.numeric && typeof v === "number") ? rule.normalize(v) : undefined;
  }
  return out as MetaFields;
}

// Hard caps (enforced in the reducer → client + server agree). Generous for
// real lists, but bound row size / DoS and keep summed totals exact under the
// bigint(mode:number) columns (MAX_ITEMS × qtyMax × UNIT_WEIGHT_MAX_MG < 2^53).
/**
 * A row id the database can hold. Every id column in the schema is a Postgres
 * `serial` (an integer), so anything past 2^31 - 1 isn't an id but a query that
 * fails — and for a catalog id it fails on every later READ of the list as well as
 * the write (hydrateCatalogNames looks the ids up). One guard for the reducer, the
 * row normalizer, the MCP tools and every route that takes an id off the wire, since
 * a made-up id is exactly what an assistant, or a hand-rolled request, produces.
 */
const MAX_SERIAL_ID = 2_147_483_647;
export const isSerialId = (raw: unknown): raw is number =>
  typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_SERIAL_ID;
/** The same range under the name the catalog call sites read it by. */
export const MAX_CATALOG_ID = MAX_SERIAL_ID;
export const isCatalogId = isSerialId;

export const MAX_ITEMS = 1000;
export const MAX_FOLDERS = 50;
// Text caps, one constant per field. The reducer, the whole-list normalizer, the
// server, the JSON importer and the field's own maxlength all read the same number,
// so none of them can drift: they had, and a field accepted 1,200 characters the
// server then cut to 200 without a word.
export const MAX_TITLE_LEN = 200;
/** The list's description: the one field that can hold paragraphs. */
export const MAX_DESCRIPTION_LEN = 4000;
export const MAX_ITEM_NAME_LEN = 200;
export const MAX_ITEM_NOTE_LEN = 2000;
export const MAX_GEAR_TYPE_LEN = 120; // commonName
export const MAX_BRAND_LEN = 120;
/** a day's or a waypoint's label */
export const MAX_LABEL_LEN = 120;
/** a day's or a waypoint's note: "Resupply at Reds, shuttle at 8" */
export const MAX_NOTE_LEN = 500;
/** a row's count, and its worn split */
export const MAX_QTY = 9999;
export const MAX_VARIANT_LEN = 120; // the size/config qualifier, typed or picked
export const MAX_FOLDER_NAME_LEN = 120;
export { MAX_PERSON_NAME_LEN };
// Past this an itinerary stops being something a person hand-enters, and the per-day
// model stops being the right tool for the trip. A bound on row size, like the two above,
// not an opinion about how long a walk should be.
export const MAX_DAYS = 60;
// A bound on row size, like the caps above, and not an opinion about how many springs a
// route may have. 100 pins is far past what anyone hand-places on one walk.
export const MAX_WAYPOINTS = 100;
// People splitting one pack list. Far past any real trail party that still shares a
// single list, and small enough that the per-person CSS filter can enumerate every
// slot statically (see atoms/item.scss) — raise one, raise the other.
export const MAX_PEOPLE = 12;
// A day's bounds are NOT the route's. 100 km is longer than any single day on foot, and
// 10,000 m of climb is more than Everest from the sea — generous for a real day, and far
// enough below a float that misbehaves to keep the jsonb honest.
const MAX_DAY_DISTANCE_M = 100_000;
const MAX_DAY_ASCENT_M = 10_000;
export const UNIT_WEIGHT_MAX_MG = 100_000_000; // 100 kg per single unit
// Per single unit, so the same 2^53 argument holds for the kcal rollup. A day of
// hard hiking runs 4–5k kcal; 1,000,000 leaves room for a whole resupply entered
// as one row without ever approaching the bound.
export const KCAL_MAX = 1_000_000;

/**
 * kcal as it is stored: whole, positive and under KCAL_MAX, or absent. Never zero: a
 * zero would read as "this food has no calories", which is a claim, where absent reads
 * as "not filled in", which is the truth. One rule for a row's patch, a whole row and a
 * piece of My Gear, so a direct POST can't store a value the editor could never have
 * produced.
 */
export const kcalOf = (v: unknown): number | undefined => {
  const k = typeof v === "number" && isFinite(v) ? Math.round(v) : 0;
  return k > 0 ? Math.min(KCAL_MAX, k) : undefined;
};

// Identity strings are clamped too. Every HUMAN field below is length-capped, but
// item/folder ids + folderId references are free-form client strings — left
// unbounded, a hostile client could pack a single `data` JSONB row to hundreds of
// MB (1000 items × a giant id), amplified ×5 by the full-copy snapshots. 128 is far
// above any real uid().
const MAX_ID_LEN = 128;
// colorKey is interpolated into a CSS value (categoryColor → `var(--category-<key>)`);
// restrict it to a safe charset so it can't smuggle a CSS token (e.g. a `url()`
// tracking beacon) onto a shared list a viewer opens.
const SAFE_COLOR_KEY = /^[a-z0-9-]{1,40}$/;

/** One physical item cannot weigh less than zero or more than the shared item cap. */
export const clampUnitWeightMg = (n: number) =>
  Math.max(0, Math.min(UNIT_WEIGHT_MAX_MG, Math.round(n)));

/**
 * Water is a volume, never a count. A water row (isWaterName) carries its whole volume as one
 * unit, so a qty above one folds into the weight: 3 × 3 L is 9 L, qty 1. Without this a
 * count could sit behind the editor's litres field, which has no stepper, and multiply
 * the total where nobody could see it (Nov 2026, a 3 L row counted as 9 kg). Kept in the
 * reducer, not in the row, so every writer owes it: the editor, the connector, an
 * import, an older client. Lossless: the line weighs what it did. A zero stays zero.
 */
export function foldWaterQty(name: string, qty: number, unitWeightMg: number): { qty: number; unitWeightMg: number } {
  return qty > 1 && isWaterName(name) ? { qty: 1, unitWeightMg: clampUnitWeightMg(unitWeightMg * qty) } : { qty, unitWeightMg };
}

/**
 * A worn count only describes a genuine partial of a base line. Keep this beside
 * the item normalizer rather than teaching add/import and update their own versions:
 * both routes must turn an all-worn line into the Worn classification and discard a
 * split from a line that has no base remainder.
 */
function normalizeWornSplit(
  qty: number,
  classification: Classification | null,
  rawWornQty: unknown,
): { classification: Classification | null; wornQty?: number } {
  const wornQty =
    typeof rawWornQty === "number" && Number.isFinite(rawWornQty)
      ? Math.round(rawWornQty)
      : 0;
  if (wornQty <= 0 || qty < 2 || classification === "worn" || classification === "consumable") {
    return { classification };
  }
  if (wornQty >= qty) return { classification: "worn" };
  return { classification, wornQty };
}

/** A stored product link: http(s) only, length-capped. Anything else is no link.
 *  Deliberately not tidied — see cleanText below on why URLs keep their apostrophes. */
const httpUrl = (raw: string): string | undefined => {
  const url = raw.trim().slice(0, MAX_URL_LEN);
  return safeUrl(url) ? url : undefined;
};

// Every HUMAN-typed string lands here: clamped, then tidied (see tidyText). Doing it
// in the reducer rather than in the fields means one rule covers paths no component
// can — a catalog pick, a LighterPack import, a restored JSON backup, and an op
// arriving at the API from a client that never ran the editor's code at all.
//
// Slice BEFORE tidy, not after. tidyText never grows a string, so the result still
// honours the cap; the order is what stops a cut landing mid-space from leaving the
// half-word's trailing space behind.
//
// URLs deliberately don't come through here — productUrl keeps its plain .slice().
// A path can legitimately carry an apostrophe (…/mens-jacket vs …/men's-jacket),
// and curling one rewrites the address to a page that isn't there.
const cleanText = (raw: string, max: number) => tidyText(raw.slice(0, max));

// ---- an item's fields: one rule each ------------------------------------------------
//
// A row reaches storage two ways. WHOLE: an add, a create, an import, a restore, where
// every field is read off a foreign object and one with nothing usable in it takes its
// default. By PATCH: an update, which names only the fields it changes. These were two
// lists of the same rules, and they drifted: a price the patch had no branch for, a
// stored zero the whole row read as one, a cleared note kept as "" by one and dropped by
// the other. ITEM_RULES is the one list. Each field's row holds both readings, built
// from the same value rule, and normalizeItem and cleanItemPatch only walk it.
//
// What stays different between the two is the same for every field, and deliberate:
//   - a whole row is foreign JSON (a hand-edited backup, a raw create), so it takes a
//     number written as a string and a name written as a number; a patch is an op a
//     typed client built, and a value of the wrong type in it is IGNORED, not coerced;
//   - a whole row with nothing usable in a field takes the default; a patch leaves the
//     stored value standing (SKIP), and removes it only when told to (CLEAR): "" for a
//     text field, null for the fields that have no empty value of their own, false for
//     a flag that is stored only when set. `undefined` can't say it: JSON drops the key.
//
// The rules that need two fields at once are not here. finishItem holds them, and both
// paths end in it.

/** A patch value that isn't one for this field: the stored value stands. */
const SKIP = Symbol("skip");
/** A patch value that says "nothing": the field is removed. */
const CLEAR = Symbol("clear");

interface ItemRule<T> {
  /** The field off a whole row. Always answers: the default, or absent, when nothing
   *  usable is there. */
  whole: (raw: unknown) => T;
  /** The field off a patch. Left out for a field no patch may set. */
  patch?: (raw: unknown) => T | typeof SKIP | typeof CLEAR;
}

const isNum = (v: unknown): v is number => typeof v === "number" && isFinite(v);
const isUnit = (v: unknown): v is Unit => typeof v === "string" && UNITS.includes(v as Unit);
const isClassification = (v: unknown): v is Classification =>
  typeof v === "string" && CLASSIFICATIONS.includes(v as Classification);
/** A reference to another row, a folder or a person: a non-empty string, clamped. "" is
 *  a truthy-looking non-id that would dodge the dangling-ref heals, so it is no id. */
const refId = (raw: unknown) => (typeof raw === "string" && raw ? raw.slice(0, MAX_ID_LEN) : undefined);
/** a row's count, whole and bounded; zero is a count */
const countOf = (n: number) => Math.max(0, Math.min(MAX_QTY, Math.round(n)));

/**
 * An optional string, absent rather than empty. `store` is the field's rule. A whole row
 * takes any truthy value as text; a patch takes only a string, and one that stores as
 * nothing CLEARS, so "" removes a brand, a note or a link, and an all-whitespace field
 * clears rather than storing " " (the emptiness test reads the stored value).
 */
const optText = (store: (s: string) => string | undefined): ItemRule<string | undefined> => ({
  whole: (raw) => (raw ? store(String(raw)) : undefined),
  patch: (raw) => (typeof raw === "string" ? (store(raw) ?? CLEAR) : SKIP),
});
/** A human-typed one-line field: capped, then tidied (cleanText). */
const typed = (max: number) => optText((s) => cleanText(s, max) || undefined);

/**
 * A flag stored only when it is set: true, or absent. A false would be a second way to
 * say what absent already says, and the two paths said it differently: a catalog pick in
 * a row's name field stored `nameOverridden: false` where the same pick added as a new
 * row stored nothing. `set` is what a whole row counts as set.
 */
const flag = (set: (raw: unknown) => boolean): ItemRule<boolean | undefined> => ({
  whole: (raw) => (set(raw) ? true : undefined),
  patch: (raw) => (typeof raw === "boolean" ? raw || CLEAR : SKIP),
});
/** A flag that is always stored, true or false. */
const bool: ItemRule<boolean> = {
  whole: Boolean,
  patch: (raw) => (typeof raw === "boolean" ? raw : SKIP),
};

/** A number the row always has. Off a whole row anything Number() can't read, and a
 *  zero, is `missing`. */
const reqNum = (store: (n: number) => number, missing: number): ItemRule<number> => ({
  whole: (raw) => store(Number(raw) || missing),
  patch: (raw) => (isNum(raw) ? store(raw) : SKIP),
});
/** An optional number: `store` answers undefined for a value it won't keep, which is
 *  absent off a whole row and CLEARS by patch. With `nullClears`, so does a null. */
const optNum = (store: (n: number) => number | undefined, nullClears = false): ItemRule<number | undefined> => ({
  whole: (raw) => (isNum(raw) ? store(raw) : undefined),
  patch: (raw) => (isNum(raw) ? (store(raw) ?? CLEAR) : raw === null && nullClears ? CLEAR : SKIP),
});

/** An optional field a patch turns off with null. `read` answers the value, or undefined
 *  for anything that isn't one: absent off a whole row, left standing by a patch. */
const nullCleared = <T>(read: (raw: unknown) => T | undefined): ItemRule<T | undefined> => ({
  whole: read,
  patch: (raw) => (raw === null ? CLEAR : (read(raw) ?? SKIP)),
});

/** The first eight characters of whatever names the currency, or nothing. */
const currencyOf = (raw: unknown) => (raw ? String(raw).slice(0, 8) : undefined);

const ITEM_RULES = {
  id: { whole: (raw) => String(raw).slice(0, MAX_ID_LEN) },
  // No patch for either: moveItem is the sole op that changes a row's folder or parent
  // (see ItemPatch), so a raw op smuggling one in is ignored. Clamped only here: the
  // addItem and moveItem cases validate them against the real folders and top-level
  // rows, which they can see and this can't.
  folderId: { whole: (raw) => refId(raw) ?? null },
  parentId: { whole: (raw) => refId(raw) ?? null },
  // the one text field that is never absent: a blank name is stored as ""
  name: {
    whole: (raw) => cleanText(String(raw ?? ""), MAX_ITEM_NAME_LEN),
    patch: (raw) => (typeof raw === "string" ? cleanText(raw, MAX_ITEM_NAME_LEN) : SKIP),
  },
  // "" clears these, so a free rename can drop the catalog-derived brand and variant
  // from a row that is now a custom one
  brand: typed(MAX_BRAND_LEN),
  variant: typed(MAX_VARIANT_LEN),
  commonName: typed(MAX_GEAR_TYPE_LEN),
  commonNameOverridden: flag(Boolean),
  nameOverridden: flag(Boolean),
  unitWeightMg: reqNum(clampUnitWeightMg, 0),
  weightOverridden: bool,
  // DISPLAY ONLY (see types.ts), but checked against the unit list so a hostile op can't
  // put arbitrary text where a unit label renders. null clears it, dropping the row back
  // to the list's displayUnit. It must survive a whole row, or a JSON round-trip and
  // every addItem would quietly reset each row to the list's unit.
  entryUnit: nullCleared((raw) => (isUnit(raw) ? raw : undefined)),
  qty: {
    // `Number(raw) || 1` read a stored 0 as 1: 0 is falsy, so the default meant for a
    // MISSING qty swallowed a real one, and a JSON backup round-tripped a qty-0 row back
    // as qty 1 and the list gained its weight. Default only when the field is absent or
    // unusable. null / undefined / "" are named because Number() turns all three into a
    // zero nobody typed.
    whole: (raw) => {
      const n = raw == null || raw === "" ? NaN : Number(raw);
      return countOf(Number.isFinite(n) ? n : 1);
    },
    patch: (raw) => (isNum(raw) ? countOf(raw) : SKIP),
  },
  // zero or below is no split. What a split may be beside the count and the class is
  // finishItem's (normalizeWornSplit), which sees all three.
  wornQty: optNum((n) => (Math.round(n) > 0 ? Math.min(MAX_QTY, Math.round(n)) : undefined)),
  // null is a value here, not a clear: it means "follow the folder"
  classification: {
    whole: (raw) => (isClassification(raw) ? raw : null),
    patch: (raw) => (raw === null || isClassification(raw) ? raw : SKIP),
  },
  // anything kcalOf won't store is absent rather than zero (see Item.kcal); null clears
  kcal: optNum(kcalOf, true),
  // An ITEM's note is a one-line input, so it is tidied like the rest and absent when
  // blank. (The LIST description is the field that holds paragraphs; see setMeta.)
  description: typed(MAX_ITEM_NOTE_LEN),
  // Scheme-checked like every other stored URL (trailUrl via normalizeTrailUrl, the
  // vault's own field via its ^https?:// gate). It had only a length clamp, so
  // "javascript:..." stored verbatim -- inert today, since nothing on a list surface
  // renders it as an href, but the CSP carries 'unsafe-inline', so the day something
  // does it is a live sink on a page strangers open. Not tidied: see cleanText.
  productUrl: optText(httpUrl),
  // What it cost. No upper bound, and free is a price.
  priceCents: optNum((n) => Math.max(0, Math.round(n))),
  // Read beside an amount and never without one: finishItem drops a currency a row has
  // no amount for, and cleanItemPatch reads this only from a patch that sets the amount.
  // So by patch every value answers, a blank one as "none", and nothing is skipped.
  currency: { whole: currencyOf, patch: (raw) => currencyOf(raw) ?? CLEAR },
  // A number re-links (a rename to a catalog pick). null UNLINKS: a free rename makes
  // the row a custom one, and the old product's link must not survive it. An id the
  // database can't hold is no link off a whole row, and by patch is ignored, so the link
  // the row has stands.
  catalogItemId: nullCleared((raw) => (isCatalogId(raw) ? raw : undefined)),
  // the linked product's weight when it was linked; kept only beside a link (finishItem)
  catalogWeightMgAtLink: optNum(clampUnitWeightMg),
  packed: bool,
  // only `true` is stored, and only a real true off a whole row
  needsCooking: flag((raw) => raw === true),
  // Who carries it: null clears. Clamped only: the addItem and updateItem cases check it
  // against the list's people (healPersonId), which this can't see. It must survive a
  // whole row, or every addItem and every JSON import would strip the assignment.
  personId: nullCleared(refId),
  sortOrder: reqNum((n) => n, 0),
  // `satisfies` over every key of Item, optional ones included: a field added to Item
  // does not compile until it has a row here, so it can't reach one path and not the other.
} satisfies { [K in keyof Item]-?: ItemRule<Item[K]> };

const ITEM_KEYS = Object.keys(ITEM_RULES) as (keyof Item)[];
/** The optional text fields, which the read-time tidy brings up to date (tidyStoredList). */
const ITEM_TEXT_KEYS = ["brand", "variant", "commonName", "description"] as const;

/**
 * The rules that take more than one field, run on the finished row by BOTH paths: a
 * whole row after its fields are read, a patched row after the patch is merged. Here
 * rather than in the table because none of them can be judged from one field.
 *
 *   - water's count folds into its volume (foldWaterQty);
 *   - a worn split is only a genuine partial of a base line (normalizeWornSplit);
 *   - a currency belongs to an amount: alone it says nothing, and the next amount saved
 *     without one would wipe it anyway;
 *   - catalogWeightMgAtLink describes the product catalogItemId names (it is the
 *     baseline the "the catalog's weight changed" nudge measures against), so a row
 *     with no link has none.
 */
function finishItem(it: Item): Item {
  Object.assign(it, foldWaterQty(it.name, it.qty, it.unitWeightMg));
  const worn = normalizeWornSplit(it.qty, it.classification, it.wornQty);
  it.classification = worn.classification;
  it.wornQty = worn.wornQty;
  if (it.priceCents == null) it.currency = undefined;
  if (it.catalogItemId == null) it.catalogWeightMgAtLink = undefined;
  return it;
}

/** A raw row → its stored form: every field by its rule in ITEM_RULES, then finishItem.
 *  The list-wide half (a real folder, a real parent, a real carrier) is the caller's. */
export function normalizeItem(raw: Item): Item {
  const source = raw as unknown as Record<string, unknown>;
  const it: Record<string, unknown> = {};
  for (const key of ITEM_KEYS) it[key] = ITEM_RULES[key].whole(source[key]);
  return finishItem(it as unknown as Item);
}

/** A patch → the fields it sets, each by its rule in ITEM_RULES. A cleared field comes
 *  back as an explicit undefined, which is what Object.assign needs to remove it. The
 *  merged row still owes finishItem: the updateItem case runs it. */
function cleanItemPatch(patch: ItemPatch): Partial<Item> {
  const source = patch as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ITEM_KEYS) {
    const read = (ITEM_RULES[key] as ItemRule<unknown>).patch;
    const value = read ? read(source[key]) : SKIP;
    if (value !== SKIP) out[key] = value === CLEAR ? undefined : value;
  }
  // The amount and its currency travel as one field. A currency is read only beside an
  // amount (alone it would re-denominate the figure already stored), and an amount that
  // names none takes none rather than keeping the last one's.
  if (!("priceCents" in out)) delete out.currency;
  return out as Partial<Item>;
}

function cleanFolderPatch(patch: Partial<Folder>): Partial<Folder> {
  const out: Partial<Folder> = {};
  // A rename to nothing is IGNORED, as a person's is (cleanPersonPatch): a folder keeps
  // a name. It was stored blank here while normalizeFolder and the read-time tidy both
  // call a blank name "Folder", so the editor showed an empty box until the save's
  // answer came back and typed "Folder" into it, and the name it had was gone.
  if (typeof patch.name === "string") {
    const name = cleanText(patch.name, MAX_FOLDER_NAME_LEN);
    if (name) out.name = name;
  }
  if (typeof patch.colorKey === "string" && SAFE_COLOR_KEY.test(patch.colorKey)) out.colorKey = patch.colorKey;
  if (typeof patch.defaultClassification === "string" && CLASSIFICATIONS.includes(patch.defaultClassification))
    out.defaultClassification = patch.defaultClassification;
  if (typeof patch.sortOrder === "number" && isFinite(patch.sortOrder)) out.sortOrder = patch.sortOrder;
  return out;
}

/**
 * A raw person → their stored form. Same contract as normalizeFolder, same guards:
 * the name cap matches the People manager's field, and colorKey passes SAFE_COLOR_KEY
 * because it is interpolated into a CSS value on pages strangers open.
 * Exported for the two other whole-list paths that must agree with the reducer —
 * the server's normalizeListData and the JSON importer.
 */
export function normalizePerson(raw: Person): Person {
  return {
    id: String(raw.id).slice(0, MAX_ID_LEN),
    // never nameless: an all-whitespace name would render an invisible, unclickable
    // chip, so it falls to a placeholder the owner can see to rename
    name: cleanText(String(raw.name ?? ""), MAX_PERSON_NAME_LEN) || "Person",
    colorKey: raw.colorKey && SAFE_COLOR_KEY.test(String(raw.colorKey)) ? String(raw.colorKey) : "other",
    sortOrder: Number(raw.sortOrder) || 0,
  };
}

function cleanPersonPatch(patch: Partial<Person>): Partial<Person> {
  const out: Partial<Person> = {};
  // a rename to nothing is IGNORED rather than stored — unlike brand ("" clears),
  // a person must keep a name; blurring an emptied field leaves the old one standing
  if (typeof patch.name === "string") {
    const name = cleanText(patch.name, MAX_PERSON_NAME_LEN);
    if (name) out.name = name;
  }
  if (typeof patch.colorKey === "string" && SAFE_COLOR_KEY.test(patch.colorKey)) out.colorKey = patch.colorKey;
  if (typeof patch.sortOrder === "number" && isFinite(patch.sortOrder)) out.sortOrder = patch.sortOrder;
  return out;
}

// An assignee this list doesn't have — removed by a concurrent editor, an offline
// queue landing after the removePerson it raced, an import naming a stranger —
// coerces to unassigned. Both item entry points (add + update) run this, and both
// ends of the wire run the same line, so a race converges on unassigned rather
// than on a nameless id. The shape half lives in cleanItemPatch, which can't see
// the list; this is the list-aware half.
function healPersonId(state: ListState, it: Item): void {
  if (it.personId && !state.people?.some((p) => p.id === it.personId)) it.personId = undefined;
}

// A day's optional metres go through trailDistance's boundedRound. Absent stays absent
// and a zero CLEARS, on the same reasoning as Item.kcal: a zero would read as "this day
// covers no ground", which is a claim, where absent reads as "not filled in". A day that
// genuinely covers no ground says so with `rest`, which is why that flag exists.

/**
 * A day patch AS IT TRAVELS — same fields as TripDay, except the clearable metre figures
 * also accept "", the sentinel meaning ERASE THIS.
 *
 * It has to be a VALUE and not `undefined`, because the patch is JSON on the way to the
 * server and JSON.stringify drops undefined keys: `{ distanceM: undefined }` serialises to
 * `{}`, so the `in` test below was false by the time the reducer ran and the clear simply
 * never happened. It worked locally and was gone on the next echo, which read as the
 * server rejecting the edit rather than never being told about it.
 *
 * Same sentinel setMeta already uses for trailDistanceM and trailAscentM, for the same
 * reason — and boundedRound already maps "" to undefined, so nothing downstream changes.
 */
export type DayPatch = Omit<Partial<TripDay>, "distanceM" | "ascentM" | "descentM"> & {
  distanceM?: number | "";
  ascentM?: number | "";
  descentM?: number | "";
};

function cleanDayPatch(patch: DayPatch): Partial<TripDay> {
  const out: Partial<TripDay> = {};
  if (typeof patch.label === "string") out.label = cleanLabel(patch.label);
  // a string survives JSON whole, so "" is its own clear and needs no sentinel
  if (typeof patch.note === "string") out.note = cleanNote(patch.note);
  // `in` rather than a truthiness test: these are all clearable, and an explicit
  // undefined/0/"" has to be able to erase a value, not be skipped as "nothing sent".
  if ("distanceM" in patch) out.distanceM = boundedRound(patch.distanceM, 1, MAX_DAY_DISTANCE_M);
  if ("ascentM" in patch) out.ascentM = boundedRound(patch.ascentM, 1, MAX_DAY_ASCENT_M);
  if ("descentM" in patch) out.descentM = boundedRound(patch.descentM, 1, MAX_DAY_ASCENT_M);
  // only `true` survives; false/absent clears the flag rather than storing a redundant
  // "this is not a rest day", exactly as a folder's "manual" sort clears rather than persists
  if ("rest" in patch) out.rest = patch.rest === true ? true : undefined;
  if (typeof patch.sortOrder === "number" && isFinite(patch.sortOrder)) out.sortOrder = patch.sortOrder;
  return out;
}

/**
 * The two ids seedRouteEnds hands out, in route order: start, then finish. Nothing reads
 * a pin as a route end by these: a copy or a restored backup re-mints them like any other
 * id, and a route end is recognised by its kind.
 */
const ROUTE_END_IDS = ["wp-start", "wp-end"] as const;

/**
 * The pins a route arrives with: where it starts, and where it finishes.
 *
 * A track's first and last points ARE these, so nobody should have to drop them by hand —
 * they appear with the route, and this is the only place that makes them. They stay
 * movable afterwards, because a trailhead is often not where the track starts: you parked
 * somewhere else, or the recording begins mid-approach. Neither the plan nor the map
 * offers to remove the only one of either, since only a new route would bring it back.
 *
 * FIXED IDS, and that is not laziness. This reducer runs on the client and again on the
 * server, and both must produce the same list — a generated id would give the same pin two
 * identities and the merge would carry both. Ids only need to be unique within one list,
 * which these are.
 *
 * ON A LOOP, ONE PIN. If the finish is within LOOP_CLOSE_M of the start it is the same
 * place, and two markers stacked on one spot reads as a rendering bug rather than as a
 * fact about the walk.
 */
export function seedRouteEnds(geo: string): Waypoint[] {
  if (!geo) return [];
  const pts = decodePolyline(geo);
  if (pts.length < 2) return [];
  const out: Waypoint[] = [{ id: ROUTE_END_IDS[0], kind: "trailhead", alongM: 0 }];
  if (!isLoop(pts)) {
    const end = cumulativeM(pts).at(-1) ?? 0;
    if (end > 0) out.push({ id: ROUTE_END_IDS[1], kind: "end", alongM: Math.round(end) });
  }
  return out;
}

/** One of the route's own ends, a trailhead or a finish, which seedRouteEnds makes. */
export const isRouteEnd = (w: { kind: string }) => w.kind === "trailhead" || w.kind === "end";

/** The route's ONLY trailhead or finish, which the plan and the map never offer to remove.
 *  A spare one can go, which is how a list copied into two of each gets back to one. */
export const isLoneRouteEnd = (w: { kind: string }, all: readonly { kind: string }[]) =>
  isRouteEnd(w) && all.filter((p) => p.kind === w.kind).length < 2;

/** A day's or a pin's label as stored: capped, tidied like every other one-line field
 *  (cleanText), and absent rather than empty. */
function cleanLabel(raw: unknown): string | undefined {
  return raw ? cleanText(String(raw), MAX_LABEL_LEN) || undefined : undefined;
}

/** A note as stored: trimmed, capped, tidied, and absent rather than empty. tidyProse,
 *  not tidyText: the note's field is a textarea, so a pasted note can hold line breaks,
 *  and they are the author's. */
function cleanNote(raw: unknown): string | undefined {
  return raw ? tidyProse(String(raw).trim().slice(0, MAX_NOTE_LEN)) || undefined : undefined;
}

/** A raw day → its stored form. Same contract as normalizeFolder/normalizeItem. */
export function normalizeDay(raw: TripDay): TripDay {
  return {
    id: String(raw.id).slice(0, MAX_ID_LEN),
    sortOrder: Number(raw.sortOrder) || 0,
    label: cleanLabel(raw.label),
    note: cleanNote(raw.note),
    distanceM: boundedRound(raw.distanceM, 1, MAX_DAY_DISTANCE_M),
    ascentM: boundedRound(raw.ascentM, 1, MAX_DAY_ASCENT_M),
    descentM: boundedRound(raw.descentM, 1, MAX_DAY_ASCENT_M),
    rest: raw.rest === true ? true : undefined,
  };
}

/** Metres along the route. Clamped rather than dropped: unlike a day's distance, a
 *  waypoint with no position is not a waypoint, so `addWaypoint` rejects it outright. */
function cleanAlongM(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  // the longest route the geometry can describe, with room to spare
  return Math.min(Math.round(n), 1_000_000);
}

/**
 * A waypoint from the wire, or null when it isn't one.
 *
 * Returns NULL rather than a repaired object, unlike normalizeDay — a day with nothing
 * filled in is a normal, meaningful state, where a waypoint without a position on the
 * route is not a partially-placed pin, it is not a pin.
 */
export function normalizeWaypoint(raw: Waypoint): Waypoint | null {
  const alongM = cleanAlongM(raw?.alongM);
  if (alongM == null || typeof raw?.id !== "string" || !raw.id) return null;
  return {
    id: raw.id.slice(0, MAX_ID_LEN),
    kind: WAYPOINT_KINDS.includes(raw.kind) ? raw.kind : "landmark",
    alongM,
    label: cleanLabel(raw.label),
    note: cleanNote(raw.note),
  };
}

/** `in`-based like cleanDayPatch, so clearing a label reaches the reducer as a clear. */
function cleanWaypointPatch(patch: Partial<Waypoint>): Partial<Waypoint> {
  const out: Partial<Waypoint> = {};
  if ("kind" in patch) out.kind = WAYPOINT_KINDS.includes(patch.kind!) ? patch.kind : "landmark";
  if ("alongM" in patch) {
    const m = cleanAlongM(patch.alongM);
    if (m != null) out.alongM = m; // a patch can move a pin, never un-place it
  }
  if ("label" in patch) out.label = cleanLabel(patch.label);
  if ("note" in patch) out.note = cleanNote(patch.note);
  return out;
}

/**
 * The guard every add shares: a real entity with a string id, room under the cap, and
 * no row already holding that id — so a replayed op is a no-op, never a duplicate.
 * `arr` may be absent (days/waypoints/people on a list written before they existed).
 */
function canAdd<T extends { id: string }>(
  arr: readonly T[] | undefined,
  entity: T | null | undefined,
  max: number,
): entity is T {
  return (
    !!entity &&
    typeof entity.id === "string" &&
    (arr?.length ?? 0) < max &&
    !arr?.some((e) => e.id === entity.id)
  );
}

/**
 * Is this entry shaped like an op at all?
 *
 * applyOp below tolerates anything (`op?.t` falls through the switch), which is the
 * contract every other reader of an op batch has to keep — and two didn't: the
 * server's `ops.some((op) => op.t === "setMeta" …)` and summarizeOps's
 * `"quiet" in op` both THREW on a null / number / string, turning one malformed
 * entry into a 500 that lost the valid ops batched with it. Exported so those
 * readers filter on the same predicate rather than each inventing a guard.
 */
export const isOpObject = (op: unknown): op is Op => isRecord(op);

/** Apply a single op in place. Unknown/invalid ops are ignored (no throw). */
function applyOp(state: ListState, op: Op): void {
  switch (op?.t) {
    case "addItem":
      if (canAdd(state.items, op.item, MAX_ITEMS)) {
        const it = normalizeItem(op.item);
        // coerce a dangling folderId (e.g. folder deleted by a concurrent editor) to null
        if (it.folderId && !state.folders.some((f) => f.id === it.folderId)) it.folderId = null;
        // a valid child inherits its parent's folder; a dangling/non-top-level/self
        // parent coerces to top-level (keeps nesting one level deep + acyclic)
        if (it.parentId) {
          const parent = state.items.find((p) => p.id === it.parentId);
          if (parent && parent.parentId == null && parent.id !== it.id) it.folderId = parent.folderId;
          else it.parentId = null;
        }
        healPersonId(state, it); // same heal as the folderId line above
        state.items.push(it);
      }
      break;
    case "updateItem": {
      const it = state.items.find((i) => i.id === op.id);
      if (it) {
        const linkedTo = it.catalogItemId;
        const patch = cleanItemPatch(op.patch || {});
        Object.assign(it, patch);
        // The link weight can only outlive a RE-LINK if the same patch stamps a fresh
        // one (finishItem has why the two are a pair).
        //
        // A catalog pick does stamp one. A pick from your own VAULT deliberately
        // doesn't (its weight is yours, not the catalog's — see ItemRow.onNameCommit),
        // and without this the previous product's spec weight stayed behind: rename a
        // linked 688 g tent to a 545 g quilt you own and the row read "Catalog: 688 g ·
        // suggest a fix", offering to correct the QUILT's catalog entry to the tent's
        // weight. Lives here, not in the row, because the pair is a fact about the
        // item — every path that re-links (an import, another client, the raw API)
        // owes the same invariant. And here rather than in finishItem, because only a
        // patch has a link the row held BEFORE to compare with.
        if (it.catalogItemId !== linkedTo && typeof patch.catalogWeightMgAtLink !== "number")
          it.catalogWeightMgAtLink = undefined;
        finishItem(it);
        healPersonId(state, it);
      }
      break;
    }
    case "removeItem":
      // removing a parent takes its nested children with it (they can't outlive it)
      state.items = state.items.filter((i) => i.id !== op.id && i.parentId !== op.id);
      break;
    case "moveItem": {
      const it = state.items.find((i) => i.id === op.id);
      if (it) {
        // reparent (only when the op carries a parentId; undefined = leave as-is). A
        // valid parent must exist, be top-level, differ from this item, and this item
        // must not itself have children — keeping nesting one level deep + acyclic.
        if (op.parentId !== undefined) {
          let parentId: string | null = null;
          if (typeof op.parentId === "string" && op.parentId !== op.id) {
            const parent = state.items.find((p) => p.id === op.parentId);
            const hasKids = state.items.some((c) => c.parentId === op.id);
            if (parent && parent.parentId == null && !hasKids) parentId = op.parentId;
          }
          it.parentId = parentId;
        }
        // a child always follows its parent's folder; otherwise honor the op's folder
        const parent = it.parentId ? state.items.find((p) => p.id === it.parentId) : null;
        if (parent) it.folderId = parent.folderId;
        else if (op.folderId === null) it.folderId = null;
        else if (typeof op.folderId === "string")
          it.folderId = state.folders.some((f) => f.id === op.folderId) ? op.folderId : null;
        if (typeof op.sortOrder === "number") it.sortOrder = op.sortOrder;
        // nested children carry their parent's folderId (types.ts) — cascade so a
        // parent crossing folders takes its children along. A no-op for every other
        // flavor: reorders keep the same folder, and a newly-nested item is
        // childless per the hasKids guard above.
        for (const c of state.items) if (c.parentId === it.id) c.folderId = it.folderId;
      }
      break;
    }
    case "addFolder":
      if (canAdd(state.folders, op.folder, MAX_FOLDERS)) state.folders.push(normalizeFolder(op.folder));
      break;
    case "updateFolder": {
      const f = state.folders.find((x) => x.id === op.id);
      if (f) Object.assign(f, cleanFolderPatch(op.patch || {}));
      break;
    }
    case "removeFolder":
      state.folders = state.folders.filter((f) => f.id !== op.id);
      state.items = state.items.filter((i) => i.folderId !== op.id);
      break;
    case "addDay":
      if (canAdd(state.days, op.day, MAX_DAYS)) (state.days ??= []).push(normalizeDay(op.day));
      break;
    case "updateDay": {
      const d = state.days?.find((x) => x.id === op.id);
      if (d) Object.assign(d, cleanDayPatch(op.patch || {}));
      break;
    }
    case "removeDay":
      // No cascade, unlike removeFolder — nothing else references a day. Items belong to
      // folders, and deliberately not to days: gear is packed for a trip, not for a
      // Tuesday, and pinning it to one would make deleting a day delete your tent.
      if (state.days) state.days = state.days.filter((d) => d.id !== op.id);
      break;
    case "addWaypoint": {
      const wp = normalizeWaypoint(op.waypoint);
      if (canAdd(state.waypoints, wp, MAX_WAYPOINTS)) (state.waypoints ??= []).push(wp);
      break;
    }
    case "updateWaypoint": {
      const w = state.waypoints?.find((x) => x.id === op.id);
      if (w) Object.assign(w, cleanWaypointPatch(op.patch || {}));
      break;
    }
    case "removeWaypoint":
      // no cascade, for the same reason removeDay has none — nothing references a waypoint
      if (state.waypoints) state.waypoints = state.waypoints.filter((w) => w.id !== op.id);
      break;
    case "addPerson":
      if (
        canAdd(state.people, op.person, MAX_PEOPLE) &&
        // the filter's sentinel word is not an id anyone may claim — a crafted
        // person named by it would hijack the Unassigned chip. Refused, not
        // re-minted: a fresh uid() here would differ between the client's replay
        // and the server's, and the two must stay one state.
        op.person.id !== UNASSIGNED
      ) {
        const person = normalizePerson(op.person);
        // A NAME IS AN IDENTITY here, not a label: the CSV Person column carries
        // the name and nothing else, so two people sharing one make that column
        // ambiguous and the round-trip lossy — and two identical chips in the
        // filter row tell the reader nothing either. Refused rather than
        // suffixed, because the person adding it is right there and can say who
        // they mean; the bulk paths, where nobody is, suffix instead.
        if (!personNameTaken(state.people, person.name)) (state.people ??= []).push(person);
      }
      break;
    case "updatePerson": {
      const p = state.people?.find((x) => x.id === op.id);
      if (p) {
        const patch = cleanPersonPatch(op.patch || {});
        // a rename onto someone else's name is dropped the way an empty one is —
        // the colour and order in the same patch still land
        if (patch.name && personNameTaken(state.people, patch.name, op.id)) delete patch.name;
        Object.assign(p, patch);
      }
      break;
    }
    case "removePerson":
      // Cascade like removeFolder — but the ITEMS SURVIVE, shedding only the
      // assignment: a person leaving the trip doesn't take the tent off the list,
      // it puts the tent back up for grabs. (Deleting a folder deletes its items
      // because they'd have nowhere to render; an unassigned item renders fine.)
      if (state.people) state.people = state.people.filter((p) => p.id !== op.id);
      for (const it of state.items) if (it.personId === op.id) it.personId = undefined;
      break;
    case "setMeta": {
      const p = op.patch || {};
      if (typeof p.title === "string") state.title = cleanText(p.title, MAX_TITLE_LEN);
      // tidyProse, not cleanText: the LIST description is the one field that can hold
      // paragraphs (no editor anywhere — it arrives from a LighterPack import or a JSON
      // backup), so it gets the apostrophes and the invisibles but keeps every line
      // break, and a backup still round-trips. An ITEM's description is a real one-line
      // input and goes through cleanText like the rest — see its row in ITEM_RULES.
      if (typeof p.description === "string")
        state.description = tidyProse(p.description.slice(0, MAX_DESCRIPTION_LEN));
      if (typeof p.displayUnit === "string" && UNITS.includes(p.displayUnit)) state.displayUnit = p.displayUnit;
      // The trail URL is VALIDATED, not just clamped: it ends up in a :href on a page
      // strangers open, and Vue won't sanitize it. An empty string clears the link;
      // anything that isn't http(s) is dropped, so a hostile client can't persist a
      // javascript: value by talking to the API directly. (A bare "alltrails.com/…"
      // is http(s): normalizeTrailUrl reads it as https, here and on the server alike.)
      if (typeof p.trailUrl === "string") {
        const href = normalizeTrailUrl(p.trailUrl);
        if (href) state.trailUrl = href;
        else if (!p.trailUrl.trim()) delete state.trailUrl;
      }
      // The clearable fields, one rule each — see META_RULES for the why per field.
      for (const key of Object.keys(META_RULES) as (keyof typeof META_RULES)[]) {
        const raw = p[key];
        const rule = META_RULES[key];
        if (typeof raw === "string" || (rule.numeric && typeof raw === "number"))
          setOrClear(state, key, rule.normalize(raw));
      }
      if (typeof p.routeGeometry === "string") {
        // normalizeRouteGeometry is the single gate, like parseProfile above: it bounds
        // the string AND the decoded point count, refuses an out-of-range coordinate
        // rather than clamping it, and returns its own canonical re-encoding so a
        // hand-edited value can't round-trip in a shape this codec didn't produce.
        const geo = normalizeRouteGeometry(p.routeGeometry);
        // THE WAYPOINTS GO WITH IT. A waypoint is a distance along THIS route — "water at
        // 6.2 miles" describes the Timberline and describes nothing at all once the
        // Wildwood is loaded in its place. Left alone they don't error; they silently
        // re-point at whatever is now 6.2 miles in, which is a confident wrong answer of
        // the worst kind, because it looks like a pin somebody placed.
        //
        // Only on a real CHANGE, so re-saving the same route keeps its pins — an
        // unconditional clear would empty them on any autosave that happened to carry the
        // geometry. And in the reducer rather than at the call sites, because there are
        // three of those already (import, clear the link, remove the trail) and the next
        // one to be added is the one that would forget.
        if (geo !== state.routeGeometry) state.waypoints = seedRouteEnds(geo ?? "");
        setOrClear(state, "routeGeometry", geo);
      }
      break;
    }
  }
}

export function applyOps(state: ListState, ops: Op[]): ListState {
  for (const op of ops) applyOp(state, op);
  return state;
}

/**
 * An already-stored list brought up to the current tidy rules, IN PLACE: its text, and
 * one shape rule, water's count folded into its volume (foldWaterQty).
 *
 * The backfill. cleanText only runs when a field is written, so without this a list
 * made before the tidy existed keeps every straight apostrophe until someone happens
 * to retype that exact field — and the moment they retype ONE, the list is visibly
 * half-and-half: "Ryan’s tent" on the row you touched, "Ryan's pack" on the one you
 * didn't. Uniformity is the whole point of the feature, so a partial application is
 * worse than none.
 *
 * Called on the READ paths, not by a migration: it is cheap (a regex over a few short
 * strings per row), it is idempotent, and it needs no deploy-time step or DB access.
 * Reads on the server go out tidied, so every surface renders the same spelling
 * immediately; the mutate path reads through here too, so the tidied form is what gets
 * written back the next time anything on the list changes. The data migrates itself,
 * at exactly the pace the lists are actually used.
 *
 * Deliberately NOT normalizeItem: that clamps and coerces every field and allocates a
 * new object per row. This touches only the text fields, by the rules a write stores
 * them with, plus a water row that still carries a count, so a read can afford to run
 * it every time. What else an older row may hold (a "renamed" flag stored false, a
 * currency with no amount, a link weight with no link) reads the same as its absence
 * everywhere, and goes the next time the row is written.
 */
export function tidyStoredList<T extends {
  title?: string;
  description?: string;
  trailLabel?: string;
  folders: Folder[];
  items: Item[];
  people?: Person[];
}>(list: T): T {
  if (typeof list.title === "string") list.title = cleanText(list.title, MAX_TITLE_LEN);
  // prose, so an imported description keeps its paragraphs — see the setMeta case
  if (typeof list.description === "string")
    list.description = tidyProse(list.description.slice(0, MAX_DESCRIPTION_LEN));
  // through its own normalizer, which is where the label's cap and blank rule live
  if (typeof list.trailLabel === "string") {
    const label = normalizeTrailLabel(list.trailLabel);
    if (label) list.trailLabel = label;
    else delete list.trailLabel;
  }
  for (const f of list.folders) f.name = cleanText(f.name ?? "", MAX_FOLDER_NAME_LEN) || "Folder";
  for (const p of list.people ?? []) p.name = cleanText(p.name ?? "", MAX_PERSON_NAME_LEN) || "Person";
  for (const it of list.items) {
    // Each text field by its own row in ITEM_RULES, so a read can't spell a field
    // differently from a write. A field the row doesn't have is left alone; one stored
    // blank (a note cleared before a cleared note was absent) reads as absent.
    it.name = ITEM_RULES.name.whole(it.name);
    for (const key of ITEM_TEXT_KEYS) if (it[key] != null) it[key] = ITEM_RULES[key].whole(it[key]);
    // productUrl left alone — an apostrophe in a path is part of the address
    // A water row stored with a count before the reducer folded one: the same fold and
    // worn-split clean-up updateItem runs, so no reader sees the count and nothing has
    // to write a fix.
    if (it.qty > 1 && isWaterName(it.name)) {
      Object.assign(it, foldWaterQty(it.name, it.qty, it.unitWeightMg));
      const worn = normalizeWornSplit(it.qty, it.classification, it.wornQty);
      it.classification = worn.classification;
      it.wornQty = worn.wornQty;
    }
  }
  return list;
}

export function normalizeFolder(raw: Folder): Folder {
  return {
    id: String(raw.id).slice(0, MAX_ID_LEN),
    name: cleanText(String(raw.name ?? ""), MAX_FOLDER_NAME_LEN) || "Folder",
    colorKey: raw.colorKey && SAFE_COLOR_KEY.test(String(raw.colorKey)) ? String(raw.colorKey) : "other",
    defaultClassification: CLASSIFICATIONS.includes(raw.defaultClassification)
      ? raw.defaultClassification
      : "base",
    // a `sortBy` from the days folders could be name/weight-sorted is dropped here:
    // every folder is in drag order now, and the field has no reader left
    sortOrder: Number(raw.sortOrder) || 0,
  };
}

/**
 * Rebase un-acked local ops onto the authoritative server snapshot — the same
 * merge the editor's flush() does, but returning a fresh object so the server
 * snapshot passed in is left untouched. Used when hydrating a list on load: the
 * server is the source of truth, with the device's pending edits replayed on top.
 * Beside applyOps rather than in shared/localList.ts, which sits on every page's
 * boot path and must not pull the reducer in with it.
 */
export function rebaseOnto(server: ListSnapshot, pending: Op[]): ListSnapshot {
  if (!pending.length) return server;
  const next = structuredClone(server);
  applyOps(next, pending);
  return next;
}
