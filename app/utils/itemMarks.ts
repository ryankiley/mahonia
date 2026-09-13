import { Backpack02Icon, CookieIcon, DropletIcon, Fuel01Icon, ShirtIcon } from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";
import { isWaterName } from "~~/shared/water";
import { isFuelRow, type Named } from "~~/shared/fuel";
import type { Classification } from "~~/shared/types";

/**
 * The glyph the CONSUMABLE mark wears — a droplet on water, a fuel can on stove fuel
 * (isFuelRow, shared/fuel), the cookie on everything else. Same class, same chip, same
 * label: water and fuel are consumables and the mark still says so. Only the picture
 * changes, because a cookie is a poor drawing of a litre of water or a canister of gas
 * — and the mark's own gloss is "food, fuel or water", three things that deserved three
 * pictures. Water is also the one consumable the app already treats as its own thing
 * (litres instead of a quantity, a fixed class, its own row in the add menu); fuel is
 * the one that is plainly not food, which is exactly what makes it worth telling apart
 * inside a Food & Fuel folder.
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
 * has no business importing. (The text rules themselves — which rows are water, which
 * are fuel — live in shared/, where the server can read them.)
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
 * in as many words ("everything in the pack, nothing worn on your body"). The share
 * views' rows need a picture for it: a base row inside a consumable folder — the stove
 * filed with the food — is the one row on the page that departs from its folder, and
 * the only class with no mark was exactly the class that needed one. (The totals chips
 * drew it too, once; they are words alone now, and this is the one reader.)
 */
export const classMark = (cls: Classification, row: Named): IconNode =>
  cls === "worn" ? ShirtIcon : cls === "consumable" ? consumableIcon(row) : Backpack02Icon;

/** The word beside that glyph — the label a flattened reader gets, and the chips' own. */
export const classLabel = (cls: Classification): string =>
  cls === "worn" ? "Worn" : cls === "consumable" ? "Consumable" : "Base";
