import { CookieIcon, DropletIcon } from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";
import { isWaterName } from "~~/shared/water";

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
