// Mutation operations — the SINGLE source of truth for how a list changes.
// The same reducer runs on the client (optimistic) and the server
// (authoritative), so the two states can never drift. Ops are designed to
// MERGE: two editors adding different items both succeed with no conflict; the
// version counter only signals "you're behind, refetch", not "rejected".

import { parseProfile } from "./profile";
import { tidyProse, tidyText } from "./tidyText";
import { boundedRound, normalizeDistanceUnit, normalizeTrailAscentM, normalizeTrailDistanceM } from "./trailDistance";
import { normalizeTrailLabel, normalizeTrailUrl } from "./trailLink";
import type { Classification, Folder, FolderSort, Item, ListState, TripDay, Unit, Waypoint } from "./types";
import { UNITS, WAYPOINT_KINDS } from "./types";
import { cumulativeM, decodePolyline, isLoop, normalizeRouteGeometry } from "./polyline";

// updateItem's patch: Partial<Item> plus `catalogItemId: null` as an explicit
// "unlink" — a free rename turns a linked item into a custom one, and the old
// product's link must not survive the rename (it would keep feeding the
// weight-drift nudge from a product the user no longer has).
// folderId is excluded: moveItem is the SOLE folder-changing op — it validates the
// target folder against the list and keeps nested children's folderId in sync,
// neither of which a bare field patch can do (cleanItemPatch can't see the list).
// entryUnit and kcal join catalogItemId in taking an explicit null: both are
// optional fields the user can turn back OFF, and `undefined` can't express that
// through a JSON body (it simply vanishes), so null is the wire's way to say
// "clear this" as distinct from "leave it alone".
export type ItemPatch = Omit<Partial<Item>, "catalogItemId" | "folderId" | "entryUnit" | "kcal"> & {
  catalogItemId?: number | null;
  entryUnit?: Unit | null;
  kcal?: number | null;
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

const CLASSES: Classification[] = ["base", "worn", "consumable"];

// `YYYY-MM-DD`, and a date that actually exists — the regex alone would accept
// 2026-02-31, which Date normalises to March and would silently move the trip.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  if (!DATE_RE.test(value)) return undefined;
  // round-trip through Date: if the parts survive, the day exists
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return undefined;
  return value;
}

function setDate(state: ListState, key: "startDate" | "endDate", raw: string): void {
  // Anything that isn't a real date CLEARS rather than persists — an unparseable
  // value is a date nobody can act on, and leaving the old one would be a lie.
  const value = normalizeCalendarDate(raw);
  if (!value) return void delete state[key];
  state[key] = value;
}
// The non-default folder sorts. "manual" is the default and stored as ABSENT (see
// cleanFolderPatch/normalizeFolder), so it isn't in this set — an incoming "manual"
// (or any unknown value) clears sortBy back to the default rather than persisting it.
const FOLDER_SORTS: FolderSort[] = ["name", "heaviest", "lightest"];

// Hard caps (enforced in the reducer → client + server agree). Generous for
// real lists, but bound row size / DoS and keep summed totals exact under the
// bigint(mode:number) columns (MAX_ITEMS × qtyMax × UNIT_WEIGHT_MAX_MG < 2^53).
export const MAX_ITEMS = 1000;
export const MAX_FOLDERS = 50;
// Past this an itinerary stops being something a person hand-enters, and the per-day
// model stops being the right tool for the trip. A bound on row size, like the two above,
// not an opinion about how long a walk should be.
export const MAX_DAYS = 60;
// A bound on row size, like the caps above, and not an opinion about how many springs a
// route may have. 100 pins is far past what anyone hand-places on one walk.
export const MAX_WAYPOINTS = 100;
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

// Identity strings are clamped too. Every HUMAN field below is length-capped, but
// item/folder ids + folderId references are free-form client strings — left
// unbounded, a hostile client could pack a single `data` JSONB row to hundreds of
// MB (1000 items × a giant id), amplified ×5 by the full-copy snapshots. 128 is far
// above any real uid().
const MAX_ID_LEN = 128;
// colorKey is interpolated into a CSS value (categoryColor → `var(--cat-<key>)`);
// restrict it to a safe charset so it can't smuggle a CSS token (e.g. a `url()`
// tracking beacon) onto a shared list a viewer opens.
const SAFE_COLOR_KEY = /^[a-z0-9-]{1,40}$/;

const clampWeight = (n: number) =>
  Math.max(0, Math.min(UNIT_WEIGHT_MAX_MG, Math.round(n)));

// Every HUMAN-typed string lands here: clamped, then tidied (see tidyText). Doing it
// in the reducer rather than in the fields means one rule covers paths no component
// can — a catalog pick, a LighterPack import, a restored JSON backup, and an op
// arriving at the API from a client that never ran the editor's code at all.
//
// Slice BEFORE tidy, not after. tidyText never grows a string, so the result still
// honours the cap; the order is what stops a cut landing mid-space from leaving the
// half-word's trailing space behind.
//
// URLs deliberately don't come through here — productUrl and imageUrl keep their
// plain .slice(). A path can legitimately carry an apostrophe (…/mens-jacket vs
// …/men's-jacket), and curling one rewrites the address to a page that isn't there.
const cleanText = (raw: string, max: number) => tidyText(raw.slice(0, max));

// Defensive clamps so a malformed op (or hostile client) can't corrupt state.
function cleanItemPatch(patch: ItemPatch): Partial<Item> {
  const out: Partial<Item> = {};
  if (typeof patch.name === "string") out.name = cleanText(patch.name, 200);
  // brand/variant: a non-empty string sets it; "" clears it (so a free rename can
  // drop the catalog-derived brand/variant from a now-custom item). The emptiness test
  // reads the TIDIED value, so an all-whitespace field clears rather than storing " ".
  if (typeof patch.brand === "string") out.brand = cleanText(patch.brand, 120) || undefined;
  if (typeof patch.variant === "string") out.variant = cleanText(patch.variant, 120) || undefined;
  // common name: a non-empty string sets it; "" clears it (mirrors brand/variant)
  if (typeof patch.commonName === "string") out.commonName = cleanText(patch.commonName, 120) || undefined;
  if (typeof patch.commonNameOverridden === "boolean") out.commonNameOverridden = patch.commonNameOverridden;
  if (typeof patch.nameOverridden === "boolean") out.nameOverridden = patch.nameOverridden;
  if (typeof patch.description === "string") out.description = cleanText(patch.description, 2000);
  if (typeof patch.productUrl === "string") out.productUrl = patch.productUrl.slice(0, 2000);
  if (typeof patch.unitWeightMg === "number" && isFinite(patch.unitWeightMg))
    out.unitWeightMg = clampWeight(patch.unitWeightMg);
  // entryUnit is DISPLAY ONLY (see types.ts) — validated against the unit list so a
  // hostile op can't put arbitrary text where a unit label renders. null/"" clears
  // it, dropping the row back to the list's displayUnit.
  if (patch.entryUnit === null) out.entryUnit = undefined;
  else if (typeof patch.entryUnit === "string" && UNITS.includes(patch.entryUnit))
    out.entryUnit = patch.entryUnit;
  // kcal: whole, non-negative. Anything that isn't a usable number CLEARS the field
  // rather than storing 0 — a zero would read as "this food has no calories", which
  // is a claim, where absent reads as "not filled in", which is the truth.
  if (patch.kcal === null) out.kcal = undefined;
  else if (typeof patch.kcal === "number" && isFinite(patch.kcal)) {
    const k = Math.round(patch.kcal);
    out.kcal = k > 0 ? Math.min(KCAL_MAX, k) : undefined;
  }
  if (typeof patch.qty === "number" && isFinite(patch.qty))
    out.qty = Math.max(0, Math.min(9999, Math.round(patch.qty)));
  if (typeof patch.wornQty === "number" && isFinite(patch.wornQty)) {
    const wq = Math.round(patch.wornQty);
    out.wornQty = wq > 0 ? Math.min(9999, wq) : undefined; // ≤0 clears the split
  }
  if (patch.classification === null || (typeof patch.classification === "string" && CLASSES.includes(patch.classification)))
    out.classification = patch.classification;
  // NO worn/consumable-clears-wornQty rule here: applyOp's updateItem arm runs it
  // on the merged item (where it can also see qty), so stating it twice only
  // creates two versions to drift.
  if (typeof patch.weightOverridden === "boolean") out.weightOverridden = patch.weightOverridden;
  // catalog link fields — a number re-links (rename to a catalog pick, or the
  // nudge re-baselining to the current weight); null UNLINKS both fields (free
  // rename → now a custom item, the old product's link must not survive)
  if (patch.catalogItemId === null) {
    out.catalogItemId = undefined;
    out.catalogWeightMgAtLink = undefined;
  } else if (typeof patch.catalogItemId === "number" && isFinite(patch.catalogItemId))
    out.catalogItemId = patch.catalogItemId;
  if (patch.catalogItemId !== null && typeof patch.catalogWeightMgAtLink === "number" && isFinite(patch.catalogWeightMgAtLink))
    out.catalogWeightMgAtLink = clampWeight(patch.catalogWeightMgAtLink);
  if (typeof patch.packed === "boolean") out.packed = patch.packed;
  if (typeof patch.sortOrder === "number" && isFinite(patch.sortOrder)) out.sortOrder = patch.sortOrder;
  // no folderId branch: a raw op smuggling one in is ignored (see ItemPatch)
  return out;
}

function cleanFolderPatch(patch: Partial<Folder>): Partial<Folder> {
  const out: Partial<Folder> = {};
  if (typeof patch.name === "string") out.name = cleanText(patch.name, 120);
  if (typeof patch.colorKey === "string" && SAFE_COLOR_KEY.test(patch.colorKey)) out.colorKey = patch.colorKey;
  if (typeof patch.defaultClassification === "string" && CLASSES.includes(patch.defaultClassification))
    out.defaultClassification = patch.defaultClassification;
  // sortBy: a known non-default sort sets it; "manual" or anything unrecognized clears
  // it back to the default (undefined) — so switching a folder back to Manual removes
  // the field (dropped by JSON.stringify) instead of persisting a redundant "manual".
  if (typeof patch.sortBy === "string")
    out.sortBy = FOLDER_SORTS.includes(patch.sortBy as FolderSort) ? (patch.sortBy as FolderSort) : undefined;
  if (typeof patch.sortOrder === "number" && isFinite(patch.sortOrder)) out.sortOrder = patch.sortOrder;
  return out;
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
  if (typeof patch.label === "string") out.label = patch.label.slice(0, 120) || undefined;
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
 * The two ids seedRouteEnds hands out, in route order: start, then finish.
 *
 * Exported because they are an IDENTITY and not an implementation detail — anything that
 * has to recognise the route's own ends among a list of pins (ensureRouteEnds, the JSON
 * importer) matches on these, so they cannot be spelled out twice and drift apart.
 */
export const ROUTE_END_IDS = ["wp-start", "wp-end"] as const;

/**
 * The pins a route arrives with: where it starts, and where it finishes.
 *
 * A track's first and last points ARE these, so nobody should have to drop them by hand —
 * they appear with the route. They are ordinary waypoints afterwards, movable and
 * deletable, because a trailhead is often not where the track starts: you parked somewhere
 * else, or the recording begins mid-approach.
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

/** A raw day → its stored form. Same contract as normalizeFolder/normalizeItem. */
export function normalizeDay(raw: TripDay): TripDay {
  return {
    id: String(raw.id).slice(0, MAX_ID_LEN),
    sortOrder: Number(raw.sortOrder) || 0,
    label: raw.label ? String(raw.label).slice(0, 120) : undefined,
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
    label: raw.label ? String(raw.label).slice(0, 120) : undefined,
    note: raw.note ? String(raw.note).slice(0, 500) : undefined,
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
  if ("label" in patch) out.label = patch.label ? String(patch.label).slice(0, 120) : undefined;
  if ("note" in patch) out.note = patch.note ? String(patch.note).slice(0, 500) : undefined;
  return out;
}

/** Apply a single op in place. Unknown/invalid ops are ignored (no throw). */
function applyOp(state: ListState, op: Op): void {
  switch (op?.t) {
    case "addItem":
      if (
        op.item &&
        typeof op.item.id === "string" &&
        state.items.length < MAX_ITEMS &&
        !state.items.some((i) => i.id === op.item.id)
      ) {
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
        state.items.push(it);
      }
      break;
    case "updateItem": {
      const it = state.items.find((i) => i.id === op.id);
      if (it) {
        const linkedTo = it.catalogItemId;
        const patch = cleanItemPatch(op.patch || {});
        Object.assign(it, patch);
        // catalogWeightMgAtLink describes the product named by catalogItemId — it is
        // the baseline the "the catalog's weight changed" nudge measures against. So
        // it can only outlive a RE-LINK if the same patch stamps a fresh one.
        //
        // A catalog pick does stamp one. A pick from your own VAULT deliberately
        // doesn't (its weight is yours, not the catalog's — see ItemRow.onNameCommit),
        // and without this the previous product's spec weight stayed behind: rename a
        // linked 688 g tent to a 545 g quilt you own and the row read "Catalog: 688 g ·
        // suggest a fix", offering to correct the QUILT's catalog entry to the tent's
        // weight. Lives here, not in the row, because the pair is a fact about the
        // item — every path that re-links (an import, another client, the raw API)
        // owes the same invariant.
        if (it.catalogItemId !== linkedTo && typeof patch.catalogWeightMgAtLink !== "number")
          it.catalogWeightMgAtLink = undefined;
        // Normalize the worn/base split after ANY patch (needs the item's current
        // qty + classification, which cleanItemPatch can't see). A split only reads
        // as a GENUINE PARTIAL of a base line with ≥2 units, so:
        //  • the item is already explicitly worn/consumable → no base remainder to
        //    split: drop it (mirrors normalizeItem; a wornQty-only patch must not
        //    resurrect a split — or flip a consumable to Worn via the collapse below)
        //  • qty < 2 → nothing to split: drop it, let the item's base class stand
        //    (not clamp to 1, which would flip the lone unit to fully worn)
        //  • every copy worn (wornQty ≥ qty) → that's just the Worn class, not a
        //    "N worn · 0 base" split with no base remainder
        //  • otherwise a real partial (1 ≤ wornQty ≤ qty−1) stays as-is
        if (it.wornQty != null) {
          if (it.classification === "worn" || it.classification === "consumable" || it.qty < 2) {
            it.wornQty = undefined;
          } else if (it.wornQty >= it.qty) {
            it.classification = "worn";
            it.wornQty = undefined;
          }
        }
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
      if (
        op.folder &&
        typeof op.folder.id === "string" &&
        state.folders.length < MAX_FOLDERS &&
        !state.folders.some((f) => f.id === op.folder.id)
      )
        state.folders.push(normalizeFolder(op.folder));
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
      if (
        op.day &&
        typeof op.day.id === "string" &&
        (state.days?.length ?? 0) < MAX_DAYS &&
        !state.days?.some((d) => d.id === op.day.id)
      )
        (state.days ??= []).push(normalizeDay(op.day));
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
      if (
        wp &&
        (state.waypoints?.length ?? 0) < MAX_WAYPOINTS &&
        !state.waypoints?.some((w) => w.id === wp.id)
      )
        (state.waypoints ??= []).push(wp);
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
    case "setMeta": {
      const p = op.patch || {};
      if (typeof p.title === "string") state.title = cleanText(p.title, 200);
      // tidyProse, not cleanText: the LIST description is the one field that can hold
      // paragraphs (no editor anywhere — it arrives from a LighterPack import or a JSON
      // backup), so it gets the apostrophes and the invisibles but keeps every line
      // break, and a backup still round-trips. An ITEM's description is a real one-line
      // input and goes through cleanText like the rest — see cleanItemPatch.
      if (typeof p.description === "string")
        state.description = tidyProse(p.description.slice(0, 4000));
      if (typeof p.displayUnit === "string" && UNITS.includes(p.displayUnit)) state.displayUnit = p.displayUnit;
      // The trail URL is VALIDATED, not just clamped: it ends up in a :href on a page
      // strangers open, and Vue won't sanitize it. An empty string clears the link;
      // anything that isn't http(s) is dropped, so a hostile client can't persist a
      // javascript: value by talking to the API directly.
      if (typeof p.trailUrl === "string") {
        const href = normalizeTrailUrl(p.trailUrl);
        if (href) state.trailUrl = href;
        else if (!p.trailUrl.trim()) delete state.trailUrl;
      }
      if (typeof p.trailLabel === "string") {
        const label = normalizeTrailLabel(p.trailLabel);
        if (label) state.trailLabel = label;
        else delete state.trailLabel;
      }
      // Metres, bounded and integer-ised by the normalizer. Anything that isn't a
      // usable distance CLEARS, on the same reasoning as the dates below: a route
      // length of "0" or "abc" is not a partially-valid state worth carrying.
      if (typeof p.trailDistanceM === "number" || typeof p.trailDistanceM === "string") {
        const metres = normalizeTrailDistanceM(p.trailDistanceM);
        if (metres) state.trailDistanceM = metres;
        else delete state.trailDistanceM;
      }
      // Anything that isn't one of the two units clears back to ABSENT, which means
      // "follow the weight unit" — the default, not a blank. Same shape as a folder's
      // "manual" sort: the default is stored by not being stored.
      if (typeof p.trailDistanceUnit === "string") {
        const unit = normalizeDistanceUnit(p.trailDistanceUnit);
        if (unit) state.trailDistanceUnit = unit;
        else delete state.trailDistanceUnit;
      }
      // Same clear-on-unusable rule as everything else here. Note this rides the ordinary
      // op pipeline: it is list state for the OWNER, and only the read paths strip it.
      if (typeof p.trailProfile === "string") {
        // parseProfile is the single gate: a hand-edited value, a truncated string or
        // anything that isn't elevations in metres clears rather than persisting.
        const prof = parseProfile(p.trailProfile);
        if (prof.length) state.trailProfile = prof.join(",");
        else delete state.trailProfile;
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
        if (geo) state.routeGeometry = geo;
        else delete state.routeGeometry;
      }
      if (typeof p.trailAscentM === "number" || typeof p.trailAscentM === "string") {
        const m = normalizeTrailAscentM(p.trailAscentM);
        if (m) state.trailAscentM = m;
        else delete state.trailAscentM;
      }
      if (typeof p.trailDescentM === "number" || typeof p.trailDescentM === "string") {
        const m = normalizeTrailAscentM(p.trailDescentM);
        if (m) state.trailDescentM = m;
        else delete state.trailDescentM;
      }
      // Dates are SHAPE-checked, not just clamped. They're rendered and exported, and
      // a half-typed "2026-0" would otherwise persist and read as a real date
      // everywhere downstream. Anything that isn't a calendar date clears the field —
      // there is no partially-valid state worth keeping.
      if (typeof p.startDate === "string") setDate(state, "startDate", p.startDate);
      if (typeof p.endDate === "string") setDate(state, "endDate", p.endDate);
      break;
    }
  }
}

export function applyOps(state: ListState, ops: Op[]): ListState {
  for (const op of ops) applyOp(state, op);
  return state;
}

export function normalizeItem(raw: Item): Item {
  const qty = Math.max(0, Math.min(9999, Math.round(Number(raw.qty) || 1)));
  let classification = CLASSES.includes(raw.classification as Classification)
    ? (raw.classification as Classification)
    : null;
  const wornQtyRaw =
    typeof raw.wornQty === "number" && isFinite(raw.wornQty) ? Math.round(raw.wornQty) : 0;
  // Resolve the worn split exactly as the op-reducer does: keep it only as a genuine
  // partial of a base-effective line with ≥2 units; an all-worn count is just the
  // Worn class, and a lone line has nothing to split.
  let wornQty: number | undefined;
  if (wornQtyRaw > 0 && qty >= 2 && classification !== "worn" && classification !== "consumable") {
    if (wornQtyRaw < qty) wornQty = wornQtyRaw;
    else classification = "worn";
  }
  // same clamp as cleanItemPatch: whole, positive, bounded — anything else is
  // absent rather than zero (see Item.kcal)
  const kcal = typeof raw.kcal === "number" && isFinite(raw.kcal) ? Math.round(raw.kcal) : 0;
  return {
    id: String(raw.id).slice(0, MAX_ID_LEN),
    // empty string collapses to null — a real id or nothing. "" is a truthy-looking
    // non-id that would dodge the dangling-ref heals (both are `if (folderId && …)`)
    // AND the strict `=== null` ungrouped predicate, leaving the item rendered in no
    // folder yet counted in totals: invisible, UI-undeletable weight.
    folderId: typeof raw.folderId === "string" && raw.folderId ? raw.folderId.slice(0, MAX_ID_LEN) : null,
    // the item this is nested under (validated against real, top-level items by the
    // addItem/moveItem reducer cases, which can see the whole list; here we only clamp)
    parentId: typeof raw.parentId === "string" && raw.parentId ? raw.parentId.slice(0, MAX_ID_LEN) : null,
    name: cleanText(String(raw.name ?? ""), 200),
    brand: raw.brand ? cleanText(String(raw.brand), 120) || undefined : undefined,
    variant: raw.variant ? cleanText(String(raw.variant), 120) || undefined : undefined,
    commonName: raw.commonName ? cleanText(String(raw.commonName), 120) || undefined : undefined,
    commonNameOverridden: raw.commonNameOverridden ? true : undefined,
    nameOverridden: raw.nameOverridden ? true : undefined,
    unitWeightMg: clampWeight(Number(raw.unitWeightMg) || 0),
    weightOverridden: !!raw.weightOverridden,
    // display-only, but it must survive normalize or a JSON round-trip (and every
    // addItem, which also runs through here) would quietly reset each row to the
    // list's unit — losing a choice the user made, invisibly
    entryUnit:
      typeof raw.entryUnit === "string" && UNITS.includes(raw.entryUnit) ? raw.entryUnit : undefined,
    qty,
    wornQty,
    classification,
    kcal: kcal > 0 ? Math.min(KCAL_MAX, kcal) : undefined,
    description: raw.description ? cleanText(String(raw.description), 2000) || undefined : undefined,
    productUrl: raw.productUrl ? String(raw.productUrl).slice(0, 2000) : undefined,
    imageUrl: raw.imageUrl ? String(raw.imageUrl).slice(0, 2000) : undefined,
    priceCents:
      typeof raw.priceCents === "number" && isFinite(raw.priceCents)
        ? Math.max(0, Math.round(raw.priceCents))
        : undefined,
    currency: raw.currency ? String(raw.currency).slice(0, 8) : undefined,
    catalogItemId:
      typeof raw.catalogItemId === "number" && isFinite(raw.catalogItemId)
        ? raw.catalogItemId
        : undefined,
    catalogWeightMgAtLink:
      typeof raw.catalogWeightMgAtLink === "number" && isFinite(raw.catalogWeightMgAtLink)
        ? clampWeight(raw.catalogWeightMgAtLink)
        : undefined,
    packed: !!raw.packed,
    sortOrder: Number(raw.sortOrder) || 0,
  };
}

/**
 * An already-stored list's text brought up to the current tidy rules, IN PLACE.
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
 * new object per row. This touches only the text and only the fields cleanItemPatch
 * would have touched, so a read can afford to run it every time.
 */
export function tidyListText<T extends {
  title?: string;
  description?: string;
  trailLabel?: string;
  folders: Folder[];
  items: Item[];
}>(list: T): T {
  if (typeof list.title === "string") list.title = cleanText(list.title, 200);
  // prose, so an imported description keeps its paragraphs — see the setMeta case
  if (typeof list.description === "string")
    list.description = tidyProse(list.description.slice(0, 4000));
  // through its own normalizer, which is where the label's cap and blank rule live
  if (typeof list.trailLabel === "string") {
    const label = normalizeTrailLabel(list.trailLabel);
    if (label) list.trailLabel = label;
    else delete list.trailLabel;
  }
  for (const f of list.folders) f.name = cleanText(f.name ?? "", 120) || "Folder";
  for (const it of list.items) {
    it.name = cleanText(it.name ?? "", 200);
    if (it.brand) it.brand = cleanText(it.brand, 120) || undefined;
    if (it.variant) it.variant = cleanText(it.variant, 120) || undefined;
    if (it.commonName) it.commonName = cleanText(it.commonName, 120) || undefined;
    if (it.description) it.description = cleanText(it.description, 2000) || undefined;
    // productUrl/imageUrl left alone — an apostrophe in a path is part of the address
  }
  return list;
}

export function normalizeFolder(raw: Folder): Folder {
  return {
    id: String(raw.id).slice(0, MAX_ID_LEN),
    name: cleanText(String(raw.name ?? ""), 120) || "Folder",
    colorKey: raw.colorKey && SAFE_COLOR_KEY.test(String(raw.colorKey)) ? String(raw.colorKey) : "other",
    defaultClassification: CLASSES.includes(raw.defaultClassification)
      ? raw.defaultClassification
      : "base",
    // only a known non-default sort survives; absent/"manual"/unknown → undefined
    // (dropped by JSON.stringify), read back as the default manual order
    sortBy: FOLDER_SORTS.includes(raw.sortBy as FolderSort) ? (raw.sortBy as FolderSort) : undefined,
    sortOrder: Number(raw.sortOrder) || 0,
  };
}
