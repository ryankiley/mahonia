import { DropletIcon, Flag02Icon, Flag03Icon, Location01Icon, TentIcon } from "@hugeicons/core-free-icons";
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
  landmark: { label: "Landmark", icon: Location01Icon, color: "var(--cat-clothing)" },
  trailhead: { label: "Trailhead", icon: Flag02Icon, color: "var(--ink)" },
  end: { label: "End", icon: Flag03Icon, color: "var(--ink)" },
};

/** Anything unrecognised reads as a landmark, so a pin always has a glyph and a name. */
export const waypointKindMeta = (kind: string) =>
  WAYPOINT_KIND_META[kind as WaypointKind] ?? WAYPOINT_KIND_META.landmark;

/**
 * The kinds you can PLACE — the three you find along a route.
 *
 * Trailhead and end come with the route and are singular by nature: offering them here
 * would let a walk grow five finishes.
 */
export const PLACEABLE_WAYPOINT_KINDS = ["water", "camp", "landmark"] as const;

export const WAYPOINT_KIND_OPTIONS = PLACEABLE_WAYPOINT_KINDS.map((k) => ({
  key: k,
  label: WAYPOINT_KIND_META[k].label,
  icon: WAYPOINT_KIND_META[k].icon,
}));
