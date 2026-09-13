import { Backpack02Icon, CookieIcon, DropletIcon, Fuel01Icon, ShirtIcon } from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";
import { isWaterName } from "~~/shared/water";
import type { Classification, Item } from "~~/shared/types";

/** The two fields a row's picture is read from — an Item has them, and so does a vault entry. */
type Named = Pick<Item, "name" | "commonName">;

/**
 * Does this row read as STOVE FUEL — a gas canister, a propane bottle, a pack of Esbit?
 *
 * Generous where isWaterName is exact, and on purpose: a water match changes what the
 * row IS (litres for a quantity, a fixed class, a derived weight), so "Water filter"
 * matching would be a bug. A fuel match changes only the picture on the consumable
 * mark, so the cost of a false positive is a fuel can where a cookie would have been
 * — two drawings of the same class — and the cost of a false negative is the cookie
 * on a gas canister, which is the thing this exists to fix. So it reads the gear type
 * as well as the name (a catalog pick says "Fuel canister" or "Fuel tablets" there,
 * whatever the maker called the product), and it takes the word, the chemistry and the
 * brands that have come to mean the thing: "Fuel", "Gas canister", "Isobutane 110g",
 * "Propane", "IsoPro", "JetPower", "Esbit", "Campingaz", "HEET", "meths".
 *
 * Two words are left out that a wider net would take. A bare "canister" is as often a
 * bear canister as a gas one, and a bare "alcohol" on a gear list is usually the
 * wipes, not the stove's — both would draw a fuel can on a row that holds no fuel.
 * ("Alcohol fuel" and "Denatured alcohol" still match, on their other word.)
 */
const FUEL_WORD =
  /\b(?:fuel|gas|propane|(?:iso)?butane|isopro|jetpower|esbit|campingaz|hexamine|heet|meths|methylated spirits?|denatured alcohol)\b/i;
export const isFuelRow = (row: Named): boolean => FUEL_WORD.test(`${row.name} ${row.commonName ?? ""}`);

/**
 * Does this consumable row OFFER a calorie field? The second thing a fuel name decides,
 * after its picture: every consumable does, except stove fuel holding no number.
 *
 * The kcal on a row is food energy — the totals bar's figure and the per-day plan
 * (shared/foodPlan) read it as what you will eat. A canister of isobutane holds about
 * 1,350 kcal of chemical energy, and a field that asks "kcal each" beside a fuel row
 * is an invitation to type exactly that, which then feeds the plan a day's ration
 * nobody eats. So the field is not offered there.
 *
 * NOT OFFERED, but never taken away with a number in it. A value that reached a fuel
 * row some other way — typed before this rule, remembered by My Gear, brought by a
 * pick, sent through the API — keeps counting exactly as Item.kcal says a stored
 * value does (a row flipped base → consumable brings its calories back for the same
 * reason: what is stored is never silently dropped from a total). And a value the
 * totals still count must keep the one field that can clear it, or it is set forever
 * — the rule the class cell already follows for a stored class (classCellShown). So a
 * fuel row with calories shows the field, with the number in it; clear it and the
 * field goes with it. Only the empty case is withheld, and the empty case is the trap.
 */
export const offersKcal = (row: Named & Pick<Item, "kcal">): boolean =>
  !isFuelRow(row) || (row.kcal ?? 0) > 0;

/**
 * The glyph the CONSUMABLE mark wears — a droplet on water, a fuel can on stove fuel,
 * the cookie on everything else. Same class, same chip, same label: water and fuel are
 * consumables and the mark still says so. Only the picture changes, because a cookie
 * is a poor drawing of a litre of water or a canister of gas — and the mark's own
 * gloss is "food, fuel or water", three things that deserved three pictures. Water is
 * also the one consumable the app already treats as its own thing (litres instead of
 * a quantity, a fixed class, its own row in the add menu); fuel is the one that is
 * plainly not food, which is exactly what makes it worth telling apart inside a
 * Food & Fuel folder.
 *
 * A fuel CAN rather than a flame: Fire02 is already the app's picture for calories
 * burned, in the Trip tab, and a flame on a canister row would have made one glyph
 * mean two things.
 *
 * It lives here rather than in each row because THREE surfaces draw this mark — the
 * editor row, the shared read row and /gear — and a rule copied three times is the
 * shape that lets the share view keep drawing a cookie after the editor stops.
 * Same reasoning as WAYPOINT_KIND_META next door; same reason it sits in `app/` and
 * not `shared/`, too: the glyphs come from the Hugeicons package, which the server
 * has no business importing.
 */
export const consumableIcon = (row: Named): IconNode =>
  isWaterName(row.name) ? DropletIcon : isFuelRow(row) ? Fuel01Icon : CookieIcon;

/**
 * A CLASSIFICATION's glyph — the full three, where the editor's toggles only ever had
 * two (worn, consumable; base is both of them unlit, which works only where the
 * toggles are on screen to be unlit).
 *
 * Base takes the BACKPACK, and it is the app's own word for the class rather than a
 * new one: base weight is what's in the pack, which is what the Carried tooltip says
 * in as many words ("everything in the pack, nothing worn on your body"). Two places
 * need a picture for it. The totals chips, where a legend with a hole in it teaches
 * two thirds of a vocabulary. And the share views' rows, where a base row inside a
 * consumable folder — the stove filed with the food — is the one row on the page that
 * departs from its folder, and the only class with no mark was exactly the class that
 * needed one.
 */
export const classMark = (cls: Classification, row: Named = { name: "" }): IconNode =>
  cls === "worn" ? ShirtIcon : cls === "consumable" ? consumableIcon(row) : Backpack02Icon;

/** The word beside that glyph — the label a flattened reader gets, and the chips' own. */
export const classLabel = (cls: Classification): string =>
  cls === "worn" ? "Worn" : cls === "consumable" ? "Consumable" : "Base";
