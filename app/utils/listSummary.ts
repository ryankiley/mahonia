// How a saved-list entry is summarised wherever it's shown as a ROW rather than
// opened: its display name and its total.
//
// The NAME is the shared one — the "Your lists" page (/mine) and the editor's
// lists rail both render it, and both have to agree on what an untitled list is
// called. The total is /mine's alone (the rail dropped it: beside a name it
// competed with the one thing you scan a nav for, and cost the name a third of
// the column). It lives here anyway because it's the same job on the same entry,
// and because the unit fallback below is the kind of detail that gets
// re-guessed differently the moment a second surface wants it.
import type { MyListEntry, Unit } from "~~/shared/types";
import { formatWeightAuto } from "~~/shared/weights";

/** An untitled list still needs a name in a list of names. */
export function savedListTitle(title: string): string {
  const n = title?.trim();
  return n && n !== "Untitled list" ? n : "Untitled list";
}

/**
 * The entry's total in the list's OWN unit system, so an imperial list summarises
 * as lb/oz rather than being converted to grams for the row. Legacy entries with
 * no stored unit fall back to metric auto.
 */
export function savedListTotal(e: MyListEntry): string {
  const system: "imperial" | "metric" = unitSystem(e.displayUnit);
  return formatWeightAuto(e.totalMg, { system });
}

function unitSystem(u?: Unit): "imperial" | "metric" {
  return u === "oz" || u === "lb" ? "imperial" : "metric";
}
