import { Backpack02Icon, CookieIcon, DropletIcon, ShirtIcon } from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";
import { isWaterName } from "~~/shared/water";
import type { Classification } from "~~/shared/types";

/**
 * The glyph the CONSUMABLE mark wears — a droplet on water, the cookie on everything
 * else. Same class, same chip, same label: water is a consumable and the mark still
 * says so. Only the picture changes, because a cookie is a poor drawing of a litre of
 * water, and water is the one consumable the app already treats as its own thing
 * (litres instead of a quantity, a fixed class, its own row in the add menu).
 *
 * It lives here rather than in each row because THREE surfaces draw this mark — the
 * editor row, the shared read row and /gear — and a rule copied three times is the
 * shape that lets the share view keep drawing a cookie after the editor stops.
 * Same reasoning as WAYPOINT_KIND_META next door; same reason it sits in `app/` and
 * not `shared/`, too: the glyphs come from the Hugeicons package, which the server
 * has no business importing.
 */
export const consumableIcon = (name: string): IconNode =>
  isWaterName(name) ? DropletIcon : CookieIcon;

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
export const classMark = (cls: Classification, name = ""): IconNode =>
  cls === "worn" ? ShirtIcon : cls === "consumable" ? consumableIcon(name) : Backpack02Icon;

/** The word beside that glyph — the label a flattened reader gets, and the chips' own. */
export const classLabel = (cls: Classification): string =>
  cls === "worn" ? "Worn" : cls === "consumable" ? "Consumable" : "Base";
