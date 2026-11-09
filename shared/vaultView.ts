// How you're LOOKING at your gear on /gear — the search, the order and the grouping,
// as three pure functions composed in that order.
//
// Its own module for the same reason shared/vaultSearch.ts is one: this is the part
// of the page that is decidable without a browser, and lifting it out is what lets
// the flatten rule and the ranker's page rules be pinned by a plain-node
// test rather than by mounting a page and clicking through a menu.

import { enoughToSearch, foldForSearch } from "./searchText";
import { foldApostrophes } from "./tidyText";
import { GEAR_FAMILIES, gearFamilyLabel, gearFamilyOf, gearGlyphFor, type GearFamily } from "./gearGlyph";
import type { VaultEntry } from "./vault";
import { rankVaultRows } from "./vaultSearch";
import { groupBy, itemDisplayName } from "./weights";

/** The page's layout-and-order control. "kinds" is the default and the only one that
 *  groups; the rest are one flat list — see groupVaultByKind for why. */
export type VaultView = "kinds" | "az" | "heaviest" | "lightest" | "recent" | "most";

/**
 * Narrow by a query, using the SAME fuzzy ranker the autocomplete and the vault pane
 * use — over the rows already in memory, so there's no request per keystroke.
 *
 * This page was a literal substring filter, on the argument that a list you are
 * LOOKING at should narrow predictably. The pane retired that same argument for a
 * better reason: a vault is a hundred-odd rows, so you type rather than scan, and a
 * substring match answers a typo with an empty page while the autocomplete two
 * inches away finds the row.
 *
 * Two things the ranker's defaults get wrong for a page, both deliberate there:
 *  • it caps at VAULT_SEARCH_LIMIT (6), for a menu that must not push the catalog
 *    off-screen. This page IS the list, so it takes every match.
 *  • it returns nothing under two characters (enoughToSearch), since one is too
 *    noisy for trigrams. In a menu that reads "keep typing"; on a page it reads "you
 *    own nothing beginning with t". A single character is a prefix question, so it
 *    falls back to the substring pass, which answers one exactly.
 */
export function searchVaultRows(rows: VaultEntry[], rawQuery: string): VaultEntry[] {
  const q = (rawQuery ?? "").trim();
  if (!q) return rows;
  const folded = foldForSearch(q);
  // A query the fold eats whole ("’", "-") is still a question about what's on screen:
  // both sides fold their apostrophes and the match is raw, as it was before the fold.
  const fold = folded ? foldForSearch : (s: string) => foldApostrophes(s.toLowerCase());
  const terms = fold(q).split(/\s+/);
  const literal = (fields: (r: VaultEntry) => (string | undefined)[]) =>
    rows.filter((r) => {
      const text = fold(fields(r).join(" "));
      return terms.every((t) => text.includes(t));
    });
  if (!enoughToSearch(q)) return literal((r) => [r.brand, r.name, r.variant, r.commonName]);
  return rankVaultRows(rows, q, Number.POSITIVE_INFINITY);
}

/** IN WHAT ORDER, across the whole vault. Every comparator tie-breaks on id, so
 *  equal runs are stable and the same vault always renders in the same order. */
export function sortVaultRows(rows: VaultEntry[], view: Exclude<VaultView, "kinds">): VaultEntry[] {
  const out = [...rows];
  switch (view) {
    case "az":
      return out.sort((a, b) => byName(a, b) || a.id - b.id);
    case "heaviest":
      return out.sort((a, b) => b.weightMg - a.weightMg || a.id - b.id);
    case "lightest":
      return out.sort((a, b) => a.weightMg - b.weightMg || a.id - b.id);
    // Compared as STRINGS. toEntry emits `new Date(x).toISOString()`, so these are
    // fixed-width Z-suffixed ISO-8601 and lexical order IS chronological — which
    // saves allocating two Dates per comparison down a thousand-row list.
    case "recent":
      return out.sort((a, b) =>
        a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : a.id - b.id,
      );
    case "most":
      return out.sort((a, b) => b.timesSeen - a.timesSeen || a.id - b.id);
  }
  return out;
}

/** A–Z with a numeric, case-insensitive collator ("Bag 2" before "Bag 10", case
 *  ignored) — a bare localeCompare put "Bag 10" first. */
function byName(a: VaultEntry, b: VaultEntry): number {
  return itemDisplayName(a.brand, a.name, a.variant).localeCompare(
    itemDisplayName(b.brand, b.name, b.variant),
    undefined,
    { sensitivity: "base", numeric: true },
  );
}

/** One kind of gear on the page: the kits, a family, or the pieces with no family. */
export interface VaultKindSection {
  key: GearFamily | "kits" | "other";
  label: string;
  entries: VaultEntry[];
}

/** A piece's family: its hand-picked icon's, else its gear type's (or name's), as the
 *  row's icon is drawn — so a piece sits under the family its icon says. */
export function vaultFamilyOf(e: Pick<VaultEntry, "icon" | "commonName" | "name">): GearFamily | null {
  return gearFamilyOf(e.icon ?? gearGlyphFor(e.commonName, e.name));
}

/**
 * My Gear by KIND: the kits first, then one section per family in the icon set's order,
 * then Other for pieces whose type matches no icon. Empty kinds are left out.
 *
 * This replaced folders (Ryan, 2026-11-08). A folder was the name of the list section a
 * piece was first saved from, so the page filed the same kind of thing under "Food" and
 * "Food & water", and a piece could sit in one folder only. A kind is read off the gear
 * type, the way the row's icon is, so nothing is filed by hand and nothing drifts; what
 * goes TOGETHER is a kit's job. A piece in a kit is still a row of its own kind — the
 * kit is a set of things you own, not where they live.
 *
 * ONLY this view groups. A search flattens, because answering a query inside eight
 * headings buries what matched, and so does a chosen ORDER: "Heaviest" inside eight
 * headings tells you the heaviest thing of each kind, not the heaviest thing you own.
 * Inside a section the rows keep the order they arrive in, most recently used first.
 */
export function groupVaultByKind(rows: VaultEntry[]): VaultKindSection[] {
  const kits = rows.filter((r) => r.kind === "kit");
  const byFamily = groupBy(
    rows.filter((r) => r.kind !== "kit"),
    (r) => vaultFamilyOf(r) ?? ("other" as const),
  );
  return [
    ...(kits.length ? [{ key: "kits" as const, label: "Kits", entries: kits }] : []),
    ...GEAR_FAMILIES.filter((f) => byFamily.has(f.key)).map((f) => ({ key: f.key, label: f.label, entries: byFamily.get(f.key)! })),
    ...(byFamily.has("other") ? [{ key: "other" as const, label: gearFamilyLabel(null), entries: byFamily.get("other")! }] : []),
  ];
}
