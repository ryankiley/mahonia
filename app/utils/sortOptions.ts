import {
  ArrowUpDownIcon,
  SortingAZ01Icon,
  SortingNineOneIcon,
  SortingOneNineIcon,
} from "@hugeicons/core-free-icons";

/**
 * How a folder's contents can be ordered — the labels and the glyphs, once.
 *
 * A folder in a list and a folder in My Gear offer the same four modes, and My
 * Gear's copy was introduced as "the editor's SORT_META verbatim" with a comment
 * saying why they must match: sorting "Heaviest first" has to read identically on
 * both surfaces or the same gesture starts meaning two things. A comment is a
 * weaker guarantee than one table, and this is the same move app/utils/unitOptions
 * made for the unit pickers.
 *
 * The two surfaces keep their own sort TYPES — a list folder's and a My Gear
 * folder's are declared by different schemas — so the table is keyed by the four
 * literals both narrow to, and each caller indexes it with its own type.
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
