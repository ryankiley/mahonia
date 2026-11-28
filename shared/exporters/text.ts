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
import { computeTotals, formatWeightAuto, isBareGroup, itemDisplayName, unitSystem } from "../weights";
import { exportSections, gearTypeBeside } from "./rows";
import { isWaterName, waterVolumeLabel } from "../water";

/**
 * The longest the whole paste may be: Instagram's 2,200-character cap on a comment, the
 * tightest box this is written for (YouTube allows 10,000). A list that runs past it
 * names what fits and says how many more, so the link at the end, the part that answers
 * every follow-up, is never the part the box cuts off. A 110-row list was 4,271.
 */
export const TEXT_MAX = 2200;

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
 * How one item names itself out loud, without its count.
 *
 * Brand + model, no variant — the same call itemSearchName() makes in shared/links.ts,
 * for the same reason: a variant is a size/config qualifier ("Regular, quilt + Fast
 * Sheet", "2P") that's noise in a sentence. The gear type trails the product name when
 * it adds something (gearTypeBeside), so "Nitecore NU25 headlamp" survives the paste
 * while a free-typed "Rain jacket" doesn't become "Rain jacket rain jacket".
 */
function itemPhrase(it: Item): string {
  const name = itemDisplayName(it.brand, it.name).trim();
  if (!name) return "";
  const common = gearTypeBeside(name, it.commonName);
  const phrase = common ? `${name} ${asCommonNoun(common)}` : name;
  // Water says its volume ("Water 3 L"): it has no count (waterVolumeLabel).
  return isWaterName(it.name) ? `${phrase} ${waterVolumeLabel(it)}` : phrase;
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
  //
  // A group that holds nothing of its own ("Monday", "Dry bag") is a heading, and in a
  // run of names a heading reads as one more item: "…Monday, Farm to Summit Beans &
  // Rice dinner, Monday, Skratch Labs…". Its rows stand for it. The same thing packed
  // in several places is said once with its whole count ("Clif Bloks Energy Chews ×5"),
  // as a person would say it, where a five-day food list named every bar five times.
  // Quantity rides along only past one: "×1" on every row is the clutter this format
  // exists to avoid.
  const counts = new Map<string, number>();
  // water's phrase carries its volume and it has no count, so it is never multiplied
  const water = new Set<string>();
  for (const { item, children } of exportSections(list).flatMap((s) => s.rows)) {
    for (const it of isBareGroup(item, children.length > 0) ? children : [item, ...children]) {
      const phrase = itemPhrase(it);
      if (!phrase) continue;
      if (isWaterName(it.name)) water.add(phrase);
      counts.set(phrase, (counts.get(phrase) ?? 0) + Math.max(1, it.qty));
    }
  }
  const names = [...counts].map(([phrase, n]) => (n > 1 && !water.has(phrase) ? `${phrase} ×${n}` : phrase));

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

  // One line, so a comment box that collapses blank lines still reads right.
  const joined = tail.length ? tail.join(" — ") : "";
  const sentence = joined && joined.charAt(0).toUpperCase() + joined.slice(1);
  const paste = (shown: string[]) => [shown.join(", "), sentence].filter(Boolean).join("\n\n");
  if (paste(names).length <= TEXT_MAX) return paste(names);
  // Past TEXT_MAX, the names that fit and a count of the rest, so the totals and the
  // link (the full list, every name included) always arrive. Measured by arithmetic,
  // name by name, rather than rebuilding the paste for every name dropped.
  const room = TEXT_MAX - (sentence ? sentence.length + 2 : 0);
  let keep = 0;
  for (let used = 0; keep < names.length; keep++) {
    const next = used + (keep ? 2 : 0) + names[keep]!.length;
    if (next + `, and ${names.length - keep - 1} more`.length > room) break;
    used = next;
  }
  return paste([...names.slice(0, Math.max(1, keep)), `and ${names.length - Math.max(1, keep)} more`]);
}
