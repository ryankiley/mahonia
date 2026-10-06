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
 * Literal matches include names and notes in any language. Every query term must
 * match, and matching rows come first. ASCII queries also use the autocomplete's
 * fuzzy ranker for typo tolerance, without its menu limit. Non-ASCII queries stay
 * literal because that ranker currently strips their characters.
 */
export function searchVaultRows(rows: VaultEntry[], rawQuery: string): VaultEntry[] {
  const q = (rawQuery ?? "").trim();
  if (!q) return rows;
  const normalize = (text: string) =>
    foldApostrophes(text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase());
  const terms = normalize(q).split(/\s+/);
  const exact = rows.filter((i) => {
    const text = normalize(`${i.brand ?? ""} ${i.name} ${i.variant ?? ""} ${i.commonName ?? ""} ${i.description ?? ""}`);
    return terms.every((term) => text.includes(term));
  });
  // Preserve Chinese literal matches and Latin typo tolerance.
  if (q.length < 2 || /[^\u0000-\u007f]/.test(q)) return exact;
  const ids = new Set(exact.map((i) => i.id));
  return [...exact, ...rankVaultRows(rows, q, Number.POSITIVE_INFINITY).filter((i) => !ids.has(i.id))];
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
    entries,
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
