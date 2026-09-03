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

import { foldApostrophes } from "./tidyText";
import type { VaultEntry, VaultFolder } from "./vault";
import { rankVaultRows } from "./vaultSearch";
import { itemDisplayName } from "./weights";

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
 *  • it returns nothing under two characters, since one is too noisy for trigrams.
 *    In a menu that reads "keep typing"; on a page it reads "you own nothing
 *    beginning with t". A single character is a prefix question, so it falls back to
 *    the substring pass, which answers one exactly.
 */
export function searchVaultRows(rows: VaultEntry[], rawQuery: string): VaultEntry[] {
  const q = (rawQuery ?? "").trim();
  if (!q) return rows;
  if (q.length < 2) {
    // Both sides fold their apostrophes: the rows are stored tidied, so "Ryan’s
    // repair kit" is on screen while the keyboard types "Ryan's". Only needed here —
    // the ranker's own foldForSearch strips non-alphanumerics on both sides.
    const needle = foldApostrophes(q.toLowerCase());
    return rows.filter((i) =>
      foldApostrophes(
        `${i.brand ?? ""} ${i.name} ${i.variant ?? ""} ${i.commonName ?? ""}`.toLowerCase(),
      ).includes(needle),
    );
  }
  return rankVaultRows(rows, q, Number.POSITIVE_INFINITY);
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

/** A–Z, with the collator options the list's name sort used, so "A–Z" means the same thing on
 *  this page as it does inside a folder in the editor ("Bag 2" before "Bag 10", case
 *  ignored). The page's own sort used a bare localeCompare and quietly disagreed with
 *  the editor it says it matches. */
function byName(a: VaultEntry, b: VaultEntry): number {
  return itemDisplayName(a.brand, a.name, a.variant).localeCompare(
    itemDisplayName(b.brand, b.name, b.variant),
    undefined,
    { sensitivity: "base", numeric: true },
  );
}

/** The per-folder item order, matching the editor's FolderSort verbs so the two
 *  surfaces sort the same way. "manual" means the vault's own default —
 *  most-recently-used first, which is the order the server already returns. */
export function sortEntries(entries: VaultEntry[], sortBy: VaultFolder["sortBy"]): VaultEntry[] {
  if (!sortBy || sortBy === "manual") return entries;
  if (sortBy === "name") return [...entries].sort(byName);
  return sortVaultRows(entries, sortBy);
}

/** One folder's worth of the page, with the two figures its header states. */
export interface VaultSection {
  folder: VaultFolder | null;
  entries: VaultEntry[];
  count: number;
  weightMg: number;
}

/**
 * One section per folder, in the holder's drag order, everything unfiled last.
 *
 * ONLY the Folders view groups. A search has always flattened here, because
 * answering a query inside a dozen mostly-empty headings buries the rows that
 * matched — and a chosen ORDER flattens for a sharper reason still: a folder already
 * carries its own (folder.sortBy, chosen per folder and stored server-side), so a
 * grouped-and-globally-sorted vault would have two sort authorities over the same
 * rows. "Heaviest" inside twelve headings tells you the heaviest thing in each
 * folder, and leaves finding the heaviest thing you OWN as an exercise.
 *
 * keepEmpty: an empty folder still shows, because it is a heading you made and
 * hiding it would make "delete" the only way to be rid of one you no longer want.
 * But not while a filter is on — "Worn" would otherwise answer with a dozen empty
 * headings and the two rows that matched buried among them, which is the same
 * failure that makes a search flatten in the first place.
 */
export function groupVaultRows(
  rows: VaultEntry[],
  folders: VaultFolder[],
  { keepEmpty }: { keepEmpty: boolean },
): VaultSection[] {
  const byFolder = new Map<number | null, VaultEntry[]>();
  for (const entry of rows) {
    const key = entry.folderId ?? null;
    const bucket = byFolder.get(key);
    if (bucket) bucket.push(entry);
    else byFolder.set(key, [entry]);
  }
  const section = (folder: VaultFolder | null, entries: VaultEntry[]): VaultSection => ({
    folder,
    entries: sortEntries(entries, folder?.sortBy),
    count: entries.length,
    // summed here rather than in the template: a section is built once per change
    // and read once per render, so the folder header's figure costs nothing extra
    weightMg: entries.reduce((sum, e) => sum + e.weightMg, 0),
  });
  return folders
    .map((f) => section(f, byFolder.get(f.id) ?? []))
    .filter((s) => keepEmpty || s.entries.length)
    .concat(byFolder.has(null) ? [section(null, byFolder.get(null)!)] : []);
}
