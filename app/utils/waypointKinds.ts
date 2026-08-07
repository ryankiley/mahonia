import { DirectionRight02Icon, DropletIcon, Flag02Icon, Flag03Icon, TentIcon } from "@hugeicons/core-free-icons";
import type { WaypointKind } from "~~/shared/types";

/**
 * What each kind of waypoint is CALLED, what it LOOKS like, and what colour it wears —
 * in one place, because the row under the map and the pin on it have to agree.
 *
 * They were separate maps in two components, which is the shape that lets a pin be blue on
 * the map and called "Camp" in its row. One object, both readers.
 *
 * It lives in `app/` rather than `shared/` on purpose: the icons come from the Hugeicons
 * package, and `shared/` is code the server runs too.
 *
 * COLOUR: water, camp and landmark are CONTENT, so they take category hues. The route's
 * own two ends are properties of the route rather than categories of thing, so they take
 * ink and differ by their glyph — which also stops five pins exhausting the palette.
 * All five avoid red, amber and orange: the elevation profile spends exactly those on
 * grade severity, and a waypoint will appear on that chart eventually.
 */
export const WAYPOINT_KIND_META: Record<WaypointKind, { label: string; icon: unknown; color: string }> = {
  water: { label: "Water", icon: DropletIcon, color: "var(--cat-water)" },
  camp: { label: "Camp", icon: TentIcon, color: "var(--cat-shelter)" },
  // A SIGNPOST, not a map pin. Location01 is the "you are here" marker every map draws —
  // inside a pin on a map it says the same thing twice, and says nothing about what is
  // actually there. A signpost is a thing you pass on a walk.
  landmark: { label: "Landmark", icon: DirectionRight02Icon, color: "var(--cat-clothing)" },
  trailhead: { label: "Trailhead", icon: Flag02Icon, color: "var(--ink)" },
  end: { label: "End", icon: Flag03Icon, color: "var(--ink)" },
};

/** Anything unrecognised reads as a landmark, so a pin always has a glyph and a name. */
export const waypointKindMeta = (kind: string) =>
  WAYPOINT_KIND_META[kind as WaypointKind] ?? WAYPOINT_KIND_META.landmark;

/**
 * The kinds you can PLACE. Two, not five, and not three.
 *
 * Trailhead and end come with the route and are singular by nature — offering them would
 * let a walk grow five finishes.
 *
 * CAMP is excluded for a different reason, and a better one: a camp is where a day ends,
 * and the itinerary already says where that is. Every day boundary draws one, moves when
 * you drag the boundary, and disappears when the day does. Letting somebody also place a
 * loose camp would put two kinds of camp on one map — one that means "day 2 ends here" and
 * one that means nothing in particular — and the first is the one worth having.
 *
 * The KIND survives in the model (see WAYPOINT_KIND_META) because pins imported from a
 * file can legitimately be camps, and because dropping a stored value is a migration. What
 * goes is only the ability to choose it by hand.
 */
export const PLACEABLE_WAYPOINT_KINDS = ["water", "landmark"] as const;

export const WAYPOINT_KIND_OPTIONS = PLACEABLE_WAYPOINT_KINDS.map((k) => ({
  key: k,
  label: WAYPOINT_KIND_META[k].label,
  icon: WAYPOINT_KIND_META[k].icon,
}));
