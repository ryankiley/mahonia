// Plain-text export — the list as one run of prose, for somewhere that strips
// formatting: a YouTube or Instagram comment, a forum reply, a DM.
//
// The sibling of markdown.ts, and deliberately not it. A comment box renders no
// Markdown, so listToMarkdown() lands there as literal "| Zpacks Duplex | 1 | 538 g |"
// rows. What people actually type into those boxes when asked "what's in that pack?"
// is names, commas, one paragraph — usually from memory, usually with a brand spelled
// wrong and an "I think that's it!" at the end. This builds that same answer off the
// list, so it's complete and the names are right.
//
// No title, no folder headings, no per-item weights: everything here is what a person
// would say out loud, and a heading is the formatting this format exists to shed.

import type { Item, ListSnapshot } from "../types";
import { computeTotals, formatWeightAuto, itemDisplayName, unitSystem } from "../weights";
import { exportSections } from "./rows";

/**
 * A gear type reads as a common noun mid-sentence ("Altra Lone Peak 9+ trail runners")
 * but is stored capitalized for the editor's sub-line ("Trail runners"). Lower the
 * first letter only when the second is already lowercase, so an acronym ("GPS", "PLB")
 * isn't mangled into "gPS".
 */
function asCommonNoun(s: string): string {
  const second = s[1];
  if (second && second !== second.toLowerCase()) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * How one item names itself out loud.
 *
 * Brand + model, no variant — the same call itemSearchName() makes in shared/links.ts,
 * for the same reason: a variant is a size/config qualifier ("Regular, quilt + Fast
 * Sheet", "2P") that's noise in a sentence. The gear type trails the product name when
 * the name doesn't already carry it, so "Nitecore NU25 headlamp" survives the paste
 * while a free-typed "Rain jacket" doesn't become "Rain jacket rain jacket".
 */
function itemPhrase(it: Item): string {
  const name = itemDisplayName(it.brand, it.name).trim();
  if (!name) return "";
  const common = it.commonName?.trim();
  const phrase =
    common && !name.toLowerCase().includes(common.toLowerCase())
      ? `${name} ${asCommonNoun(common)}`
      : name;
  // Quantity rides along only when there's more than one. Nearly every row is one of a
  // thing, and "×1" on all of them is exactly the clutter this format exists to avoid.
  return it.qty > 1 ? `${phrase} ×${it.qty}` : phrase;
}

/**
 * The list as a pasteable sentence.
 *
 * `shareUrl` is supplied by the CALLER rather than derived here, and that is
 * deliberate: in the editor `location.href` is the EDIT link, and an edit token pasted
 * into a public comment hands the list to everyone who reads it. Each caller passes the
 * link it means — the read-only one from the editor, the current page from a read view.
 */
export function listToText(list: ListSnapshot, opts: { shareUrl?: string } = {}): string {
  // exportSections carries the app's visible order, shared with CSV and Markdown so the
  // three can't disagree about what comes first. Folders are FLATTENED — the answer to
  // "what's in your pack?" is one run of names — and nested children follow their
  // parent, as they do in the CSV.
  const names = exportSections(list)
    .flatMap((s) => s.rows.flatMap((r) => [r.item, ...r.children]))
    .map(itemPhrase)
    .filter(Boolean);

  const tail: string[] = [];
  const totals = computeTotals(list);
  if (totals.hasWeights) {
    // formatWeightAuto, not formatWeight: this is a prose surface, where "4.2 kg" reads
    // and "4,200 g" doesn't. The list's own unit still picks the SYSTEM, so an imperial
    // list stays in oz/lb. Base and total only — those are the two figures the reply to
    // one of these comments always asks for next.
    const system = unitSystem(list.displayUnit);
    const base = formatWeightAuto(totals.baseMg, { system });
    tail.push(`Base weight ${base}, ${formatWeightAuto(totals.totalMg, { system })} total`);
  }
  // The link is what makes the paste worth more than the typing it replaces: it answers
  // the follow-up ("what does it weigh?", "what did you leave out?") without a second
  // comment.
  const url = opts.shareUrl?.trim();
  if (url) tail.push(`full list at ${url}`);

  const body = names.join(", ");
  // One line, so a comment box that collapses blank lines still reads right.
  const sentence = tail.length ? tail.join(" — ") : "";
  return [body, sentence && sentence.charAt(0).toUpperCase() + sentence.slice(1)]
    .filter(Boolean)
    .join("\n\n");
}
