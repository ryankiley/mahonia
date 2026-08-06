import { DISPLAY_DISTANCE_UNITS, BODY_WEIGHT_UNITS } from "~~/shared/trailDistance";
import { UNITS } from "~~/shared/types";

/**
 * The unit pickers' option lists, built once.
 *
 * Three components were each mapping the same constants into the same `{ key, label }`
 * shape — TotalsBar, TrailPlanPanel, and the editor once it grew a headline of its own.
 * Four copies of one line is not expensive, but it is four places a label could start
 * differing from its neighbours, and the whole point of these pickers is that the same
 * gesture reads the same wherever it appears.
 *
 * Module scope, so they are allocated once rather than rebuilt on every render — an
 * options array that is a new object each time makes the menu below it re-render for no
 * reason.
 */
export const WEIGHT_UNIT_OPTIONS = UNITS.map((u) => ({ key: u, label: u }));
export const DISTANCE_UNIT_OPTIONS = DISPLAY_DISTANCE_UNITS.map((u) => ({ key: u, label: u }));
export const BODY_WEIGHT_UNIT_OPTIONS = BODY_WEIGHT_UNITS.map((u) => ({ key: u, label: u }));
