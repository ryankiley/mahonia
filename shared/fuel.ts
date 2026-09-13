// Stove fuel — the consumable that is not food and cannot be worn.
//
// Beside shared/water.ts on purpose: water and fuel are the two consumables the app
// treats as their own thing, and this is the text rule that says which rows are fuel,
// plus the two things that rule decides beyond the row's picture (which lives in
// app/utils/itemMarks.ts, with the glyphs): whether the row is offered a calorie
// field, and whether it is offered a worn toggle. Pure text, no icon in sight, so it
// sits in shared/ where a server path (the MCP server, an importer) can read it the
// way they read isWaterName — the editor and My Gear are only its first readers.

import type { Item } from "./types";
import { isWaterName } from "./water";

/** One item marked for cooking assumes one boil at this rough fuel allowance. */
export const ASSUMED_FUEL_PER_BOIL_G = 10;

/** The two fields a row is read by here — an Item has them, and so does a vault entry. */
export type Named = Pick<Item, "name" | "commonName">;

/**
 * Does this row read as STOVE FUEL — a gas canister, a propane bottle, a pack of Esbit?
 *
 * It reads the gear type as well as the name (a catalog pick says "Fuel canister" or
 * "Fuel tablets" there, whatever the maker called the product), and it takes the word,
 * the chemistry and the brands that have come to mean the thing: "Fuel", "Gas canister",
 * "Isobutane 110g", "Propane", "IsoPro", "JetPower", "Esbit", "Campingaz", "HEET",
 * "meths". Not the brand field: Esbit and Campingaz make stoves too, and a brand says
 * who made a thing, not what it is.
 *
 * Wider than isWaterName's exact "water", because a fuel match is a smaller claim than a
 * water match — nothing about the row's weight or class changes — but it is not a free
 * one either: a match also swaps the row's picture, withholds its calorie field while it
 * holds no number (offersKcal) and its worn toggle (offersWorn). So the net is narrowed
 * twice. A bare "canister" is as often a bear canister as a gas one, and a bare "alcohol"
 * on a gear list is usually the wipes; neither is taken. And a name that says the thing
 * is EATEN outranks the fuel word in it: sports nutrition is full of "fuel" — Tailwind
 * Endurance Fuel, SiS Beta Fuel, a Precision Fuel gel — and a drink mix that lost its
 * calorie field would be the one row this rule exists to protect, refused.
 */
const FUEL_WORD =
  /\b(?:fuel|gas|propane|(?:iso)?butane|isopro|jetpower|esbit|campingaz|hexamine|heet|meths|methylated[\s-]+spirits?|denatured[\s-]+alcohol)\b/i;
// what you eat or drink, or wear: a row saying one of these is not the stove's fuel,
// whatever else its name says
const NOT_FUEL_WORD =
  /\b(?:gels?|chews?|bars?|drink|powder|pouch|meals?|snacks?|electrolytes?|endurance|energy|nutrition|hydration|waffles?|cookies?|gummies|coffee|smoothie|belt)\b/i;

const text = (row: Named): string => `${row.name} ${row.commonName ?? ""}`;

export const isFuelRow = (row: Named): boolean => {
  const t = text(row);
  return FUEL_WORD.test(t) && !NOT_FUEL_WORD.test(t);
};

/**
 * Does this consumable row OFFER a calorie field? Every consumable does, except stove
 * fuel holding no number.
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
 * — the rule the editor's class cell already follows for a stored class. So a fuel
 * row with calories shows the field, with the number in it; clear it and the field
 * goes with it. Only the empty case is withheld, and the empty case is the trap.
 *
 * The caller says whether the row is consumable at all — the editor knows it from the
 * folder, My Gear's dialog from its picker — so this decides only the fuel half.
 */
export const offersKcal = (row: Named & Pick<Item, "kcal">): boolean =>
  !isFuelRow(row) || (row.kcal ?? 0) > 0;

/**
 * Is this row OFFERED a worn toggle? Not water and not stove fuel: nobody wears a litre
 * of water or a gas canister, and a toggle that can only honestly be answered one way
 * is a control that lies. KEPT where the row already says worn (`worn`: by class, or by
 * a split of its count) — a value the totals count must keep the one control that can
 * clear it, or it is set forever with no way back. The same shape as offersKcal, for
 * the same reason, and one rule for the editor's toggle and My Gear's type picker.
 */
export const offersWorn = (row: Named, worn: boolean): boolean =>
  worn || (!isWaterName(row.name) && !isFuelRow(row));
