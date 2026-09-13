import { CookieIcon, DropletIcon, Fuel01Icon } from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";
import { isWaterName } from "~~/shared/water";
import { isFuelRow, type Named } from "~~/shared/fuel";

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
 *
 * Only this one glyph rule lives here. The share row's other two pictures — the shirt
 * and the BACKPACK for a base row that departs from its folder — are that row's own
 * (ReadonlyItemRow, its one reader): this module rides the editor's first load now,
 * and an icon the editor never draws has no business on it.
 */
export const consumableIcon = (row: Named): IconNode =>
  isWaterName(row.name) ? DropletIcon : isFuelRow(row) ? Fuel01Icon : CookieIcon;
