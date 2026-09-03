import {
  ArrowUpDownIcon,
  SortingAZ01Icon,
  SortingNineOneIcon,
  SortingOneNineIcon,
} from "@hugeicons/core-free-icons";

/**
 * How a My Gear folder's contents can be ordered — the labels and the glyphs, once.
 *
 * A list's folders used to offer the same four modes from the same table (so
 * "Heaviest first" read identically on both surfaces); that control is gone from
 * the editor — a list folder is drag order only — and My Gear is the one caller
 * left. The table is keyed by the four literals its schema narrows to.
 *
 * The glyphs read as a matched "sort key" family: A–Z for the name sort, digits
 * for the numeric (weight) sorts. The weight arrow flips — down for
 * heaviest/descending, up for lightest/ascending — so the two weight modes stay
 * distinguishable at 16px, where the digit order alone (1-0 against 0-1) isn't.
 *
 * `icon` is PATH DATA rather than a component, and the package's exported icons
 * are readonly, so its mutable IconArray doesn't accept them. Borrowing the type
 * from one of the four is both exact and self-maintaining — it is also why a
 * template can't reach these through <component :is>.
 *
 * Module scope, so the table and the order array are allocated once rather than
 * rebuilt per render; an options array that is a new object every time makes the
 * menu below it re-render for nothing.
 */
export type SortKey = "manual" | "name" | "heaviest" | "lightest";

export const SORT_META: Record<SortKey, { label: string; icon: typeof ArrowUpDownIcon }> = {
  manual: { label: "Manual order", icon: ArrowUpDownIcon },
  name: { label: "Name (A–Z)", icon: SortingAZ01Icon },
  heaviest: { label: "Heaviest first", icon: SortingNineOneIcon },
  lightest: { label: "Lightest first", icon: SortingOneNineIcon },
};

export const SORT_ORDER: SortKey[] = ["manual", "name", "heaviest", "lightest"];
