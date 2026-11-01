// How you're LOOKING at your gear on /gear — the filter, the search, the order and
// the grouping, as four pure functions composed in that order.
//
// Its own module for the same reason shared/vaultSearch.ts is one: this is the part
// of the page that is decidable without a browser, and lifting it out is what lets
// the flatten rule and the "base means absent too" rule be pinned by a plain-node
// test rather than by mounting a page and clicking two menus.
//
// Two questions, two controls. WHICH gear (`show`) and IN WHAT ORDER (`view`) are
// independent axes, and only the second one decides whether the page has folders.

import { enoughToSearch, foldForSearch } from "./searchText";
import { foldApostrophes } from "./tidyText";
import { countedWeightMg, type VaultEntry, type VaultFolder } from "./vault";
import { rankVaultRows } from "./vaultSearch";
import { groupBy, itemDisplayName } from "./weights";

/** The page's layout-and-order control. "folders" is the default and the only one
 *  that groups; the rest are one flat list — see groupVaultRows for why. */
export type VaultView = "folders" | "az" | "heaviest" | "lightest" | "recent" | "most";

/** The page's filter. Mixes two axes — filing and classification — which is a smell,
 *  but they are mutually exclusive questions in practice ("where is it" vs "what kind
 *  is it"), and a second picker on a page this quiet costs more than the mixing does. */
export type VaultShow = "all" | "unfiled" | "base" | "worn" | "consumable";

/**
 * WHICH gear.
 *
 * "base" has to accept an ABSENT classification as well as the literal string.
 * Capture drops the field when a list row was inheriting its folder's default (see
 * VaultCapture.classification — "a fact about the list, not the gear"), so most base
 * gear carries no value at all, and `=== "base"` would match almost none of it.
 */
export function filterVaultRows(rows: VaultEntry[], show: VaultShow): VaultEntry[] {
  if (show === "all") return rows;
  if (show === "unfiled") return rows.filter((i) => i.folderId == null);
  if (show === "base") return rows.filter((i) => (i.classification ?? "base") === "base");
  return rows.filter((i) => i.classification === show);
}

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
 *
 * And one thing it reads too narrowly for a page: the ranker searches what a row IS
 * (brand, name, variant, common name), never what you WROTE about it. The page also
 * holds your notes, so a literal pass over them follows the ranked rows — after, not
 * among them, because a note that mentions the Duplex must not outrank the Duplex.
 * The literal pass folds both sides through the same fold as the ranker, so it
 * matches a name in any script and either apostrophe spelling, exactly as the
 * ranker does, and "x-mid" finds "X-Mid 2".
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
  const ranked = rankVaultRows(rows, q, Number.POSITIVE_INFINITY);
  const seen = new Set(ranked.map((r) => r.id));
  const noted = literal((r) => [r.brand, r.name, r.variant, r.commonName, r.description]);
  return [...ranked, ...noted.filter((r) => !seen.has(r.id))];
}

/** IN WHAT ORDER, across the whole vault. Every comparator tie-breaks on id, so
 *  equal runs are stable and the same vault always renders in the same order. */
export function sortVaultRows(rows: VaultEntry[], view: Exclude<VaultView, "folders">): VaultEntry[] {
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

/**
 * What a set of rows weighs, counting each piece once and a kit only by its own
 * weight — the FLAT reckoning, for a file: every piece is a line of its own there,
 * so a kit's items are already counted as the lines they are.
 */
export function vaultTotalMg(rows: readonly VaultEntry[]): number {
  return rows.reduce((sum, e) => sum + countedWeightMg(e), 0);
}

/**
 * The rows as the page shows them nested: an item that is in a kit among these rows
 * lives under that kit and is not a row of its own. Only a kit that IS among the rows
 * hides its items — under a filter that leaves the kit out (a worn item in a kit that
 * isn't worn), the item is a row again.
 */
export function nestedRows(rows: readonly VaultEntry[]): VaultEntry[] {
  const kitsHere = new Set(rows.filter((r) => r.kind === "kit").map((r) => r.id));
  return kitsHere.size ? rows.filter((r) => !(r.inKits ?? []).some((id) => kitsHere.has(id))) : [...rows];
}

/**
 * What the gear on the page weighs, the way the page shows it: each row's own weight,
 * a kit counted whole with its items at the counts it holds them. The same sum the
 * folder figures make, so the page's total is theirs added up — and a kit holding
 * three lighters weighs three lighters here, where the flat reckoning (vaultTotalMg)
 * would count the one lighter row once.
 */
export function vaultShownMg(rows: readonly VaultEntry[]): number {
  return nestedRows(rows).reduce((sum, e) => sum + e.weightMg, 0);
}

/** One folder's worth of the page, with the figures its header states. */
export interface VaultSection {
  folder: VaultFolder | null;
  entries: VaultEntry[];
  /** the PIECES shown here as rows; kits are counted apart, in `kits` */
  count: number;
  /** the kits filed here */
  kits: number;
  /** What the rows here weigh. Nested, a kit counts whole — its items are under it
   *  and nowhere else on the page — so the figure is the rows' weights added up, the
   *  sum you'd make by eye. Flat (an export), each piece counts once wherever it is
   *  filed and a kit adds only its own weight (vaultTotalMg). */
  weightMg: number;
}

/**
 * One section per folder, in the holder's drag order, everything unfiled last.
 *
 * ONLY the Folders view groups. A search has always flattened here, because
 * answering a query inside a dozen mostly-empty headings buries the rows that
 * matched — and a chosen ORDER flattens too: "Heaviest" inside twelve headings
 * tells you the heaviest thing in each folder, and leaves finding the heaviest
 * thing you OWN as an exercise. Inside a folder the rows keep the server's order,
 * most recently used first.
 *
 * keepEmpty: an empty folder still shows, because it is a heading you made and
 * hiding it would make "delete" the only way to be rid of one you no longer want.
 * But not while a filter is on — "Worn" would otherwise answer with a dozen empty
 * headings and the two rows that matched buried among them, which is the same
 * failure that makes a search flatten in the first place.
 *
 * nest: a piece that is in a kit lives UNDER that kit, not also as a row of its own
 * folder (nestedRows) — the page you browse, and the pane's categories, which are
 * that page's folders, show each thing you own once. Showing a part twice, once in
 * its folder and once in its kit, left folder figures that couldn't be added up by
 * eye. Off for the exporters, which want every piece as a line of its own.
 */
export function groupVaultRows(
  rows: VaultEntry[],
  folders: VaultFolder[],
  { keepEmpty, nest = false }: { keepEmpty: boolean; nest?: boolean },
): VaultSection[] {
  const shown = nest ? nestedRows(rows) : rows;
  // null is the unfiled bucket, a real key
  const byFolder = groupBy(shown, (entry) => entry.folderId ?? null);
  const section = (folder: VaultFolder | null, entries: VaultEntry[]): VaultSection => ({
    folder,
    entries,
    count: entries.filter((e) => e.kind !== "kit").length,
    kits: entries.filter((e) => e.kind === "kit").length,
    // summed here rather than in the template: a section is built once per change
    // and read once per render, so the folder header's figure costs nothing extra
    weightMg: nest ? entries.reduce((sum, e) => sum + e.weightMg, 0) : vaultTotalMg(entries),
  });
  return folders
    .map((f) => section(f, byFolder.get(f.id) ?? []))
    .filter((s) => keepEmpty || s.entries.length)
    .concat(byFolder.has(null) ? [section(null, byFolder.get(null)!)] : []);
}
