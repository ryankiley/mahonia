// What a batch of edits actually DID, in one short phrase.
//
// The sharing panel's "Recent changes" listed five identical "Edited"s, because a
// recovery point stores only a reason, a time and an item count — none of which say
// what happened. Counts give you add/remove and nothing else: a rename, a re-weigh
// and a reclassify all leave the count untouched.
//
// The ops DO say. They are the exact description of a change, and the mutate path
// already holds them at the moment it captures the snapshot — so the summary is
// derived once, on write, and stored. Reading it back costs nothing.
//
// NAMES come from the list as it stood BEFORE the batch, which the caller passes
// in. That state is why removals are nameable at all: the op is only `{ id }`, and
// by the time anyone reads the history the row is gone — but the server holds the
// pre-edit row at exactly the moment it summarises. Without a `before` this falls
// back to the counts it always produced, so the function stays usable bare.
//
// Pure + shared so the wording is written down once: the server stores it and the
// panel renders it verbatim, rather than each having a half-opinion about phrasing.

import { foldForSearch } from "./catalogSearch";
import type { Folder, Item, Person } from "./types";
import { itemDisplayName } from "./weights";
import { tidyText } from "./tidyText";
import { isOpObject, type Op } from "./ops";

/** Longer than this and it stops being a label. */
export const MAX_SUMMARY_LEN = 80;

/** The list as it stood before the batch — what makes names resolvable. */
interface SummaryBefore {
  items: readonly Item[];
  folders: readonly Folder[];
  // optional like the field it names: without it a removePerson still counts,
  // it just can't say who left
  people?: readonly Person[];
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
// "person" is the one noun here whose plural isn't an s
const persons = (n: number) => (n === 1 ? "1 person" : `${n} people`);

/**
 * A count, and the names that go with it.
 *
 * Every kind of edit the summary tracks does the same two things per op — bump a
 * count, and maybe keep a name — and asks the same question at the end: can this be
 * said as one name? A history line is capped at MAX_SUMMARY_LEN and three gear names
 * do not fit in eighty characters — so naming is for the single case, which is also
 * the case where a name tells you something a count can't.
 *
 * `names` can be SHARED between two tallies (folders added and removed both write
 * folderNames), which is why it's injectable: a batch that added one folder and
 * removed another holds two names, and neither side may then claim the line.
 */
class Tally {
  n = 0;
  constructor(readonly names: string[] = []) {}
  /** Count one; keep its name when there is one (a blank is not a name). */
  add(name?: string | null): void {
    this.n++;
    if (name) this.names.push(name);
  }
  /** The one name, when this is exactly one thing with exactly one name. */
  only(): string | undefined {
    return this.n === 1 && this.names.length === 1 ? this.names[0] : undefined;
  }
  /** Name one thing, or count several. */
  one(noun: string): string {
    return this.only() ?? plural(this.n, noun);
  }
}

/**
 * Did a rename change the gear, or only tidy how it's written?
 *
 * "Arcteryx" → "Arc'teryx" is a missing glyph; "durston x-mid" → "Durston X-Mid" is
 * capitalisation. Neither is history worth reading, and both are common.
 *
 * The catalog's fold gets most of the way — NFD, strip diacritics, lowercase — but
 * it collapses punctuation to a SPACE rather than removing it, because search wants
 * "Arc'teryx" to tokenise. That makes it exactly wrong here: the apostrophe splits
 * the word, so the two spellings fold differently and the glyph fix reads as a
 * rename. Dropping the spaces afterwards compares the letters alone, which is the
 * question being asked. A definite test, not a guessed similarity threshold.
 */
const letters = (s: string) => foldForSearch(s).replace(/\s+/g, "");
const isCosmetic = (before: string, after: string) => letters(before) === letters(after);

export function summarizeOps(ops: readonly Op[], before?: SummaryBefore): string {
  // Gestures the editor performs on your behalf carry `quiet`: a blank row tidying
  // itself away on blur, a nesting container dissolving, a row being indented. They
  // are real ops the reducer must apply, and none is a thing anyone would say they
  // did. Filtered here rather than at the source, so the list still receives them.
  //
  // The object test is not defensive noise: applyOp tolerates a malformed op by
  // design ("Unknown/invalid ops are ignored (no throw)" — its switch reads `op?.t`),
  // and `"quiet" in op` THROWS on a null / number / string, which turned one bad
  // entry in a batch into a 500 that discarded every valid op beside it.
  const reportable = ops.filter(
    (op) => isOpObject(op) && !("quiet" in op && op.quiet),
  );
  if (!reportable.length) return "";

  const itemsById = new Map((before?.items ?? []).map((i) => [i.id, i]));
  const foldersById = new Map((before?.folders ?? []).map((f) => [f.id, f]));
  const peopleById = new Map((before?.people ?? []).map((p) => [p.id, p]));
  const labelOf = (id: string) => {
    const it = itemsById.get(id);
    return it ? itemDisplayName(it.brand, it.name, it.variant) : "";
  };

  const added = new Tally(), removed = new Tally();
  // one name list across add and remove, for folders and again for people — see Tally
  const folderNames: string[] = [];
  const foldersAdded = new Tally(folderNames), foldersRemoved = new Tally(folderNames);
  const daysAdded = new Tally(), daysRemoved = new Tally(), daysEdited = new Tally();
  const wpsAdded = new Tally(), wpsRemoved = new Tally(), wpsEdited = new Tally();
  const personNames: string[] = [];
  const peopleAdded = new Tally(personNames), peopleRemoved = new Tally(personNames);
  const peopleEdited = new Tally();
  const renamed = new Tally(), swapped = new Tally(), reweighed = new Tally();
  const reclassified = new Tally(), reassigned = new Tally(), moved = new Tally();
  const packed = new Tally(), meta = new Tally(), other = new Tally();

  for (const op of reportable) {
    switch (op.t) {
      case "addItem":
        added.add(itemDisplayName(op.item?.brand, op.item?.name, op.item?.variant));
        break;
      case "removeItem": {
        const n = labelOf(op.id);
        // A row with no name was never gear — it's a blank someone abandoned, and
        // "Removed" describes nothing. (The editor marks the ones it tidies away
        // itself with `quiet`; this catches any that reach here another way.)
        if (before && !n) break;
        removed.add(n);
        break;
      }
      case "addFolder":
        foldersAdded.add(op.folder?.name);
        break;
      case "removeFolder":
        foldersRemoved.add(foldersById.get(op.id)?.name);
        break;
      case "moveItem": {
        const n = labelOf(op.id);
        const to = op.folderId ? foldersById.get(op.folderId)?.name : null;
        moved.add(n && to ? `${n} to ${to}` : undefined);
        break;
      }
      case "addDay":
        daysAdded.add();
        break;
      case "removeDay":
        daysRemoved.add();
        break;
      case "updateDay":
        daysEdited.add();
        break;
      case "addWaypoint":
        wpsAdded.add();
        break;
      case "removeWaypoint":
        wpsRemoved.add();
        break;
      case "updateWaypoint":
        wpsEdited.add();
        break;
      case "addPerson":
        peopleAdded.add(op.person?.name);
        break;
      case "removePerson":
        peopleRemoved.add(peopleById.get(op.id)?.name);
        break;
      case "updatePerson": {
        // a rename is worth naming, the way an item rename is — recolors and
        // reorders stay a count (nobody scans history for a hue change)
        let rename: string | undefined;
        if (typeof op.patch?.name === "string") {
          const was = peopleById.get(op.id)?.name;
          // sliced to the reducer's own cap, so the line quotes the name the
          // list actually stored, not the untrimmed one the patch carried
          const now = tidyText(op.patch.name.slice(0, 60));
          if (was && now && was !== now) rename = `${was} → ${now}`;
        }
        peopleEdited.add(rename);
        break;
      }
      case "setMeta":
        meta.add();
        break;
      case "updateFolder":
        other.add();
        break;
      case "updateItem": {
        const p = op.patch ?? {};
        const was = itemsById.get(op.id);
        // Checked in the order a person would describe them. A patch usually carries
        // one intent; when it carries several, the first match wins rather than the
        // row being counted three times.
        if (typeof p.name === "string" || typeof p.brand === "string" || typeof p.variant === "string") {
          // Brand, name and variant are three fields of ONE label, so they're
          // compared as the label a person reads rather than field by field —
          // otherwise adding a size reads as a rename, and swapping the maker
          // doesn't read as anything at all.
          const beforeLabel = was ? itemDisplayName(was.brand, was.name, was.variant) : "";
          // The patch's fields are read through the SAME tidy the reducer will apply
          // (shared/tidyText), because this label is quoted verbatim into the stored
          // history. Reading the patch raw made the summary say
          // «Renamed Ryan’s tent → Ryan's  big   tent» — the right of that arrow is a
          // string that exists nowhere in the list and never did.
          const afterLabel = was
            ? itemDisplayName(
                p.brand !== undefined ? tidyText(p.brand) : was.brand,
                p.name !== undefined ? tidyText(p.name) : was.name,
                p.variant !== undefined ? tidyText(p.variant) : was.variant,
              )
            : "";
          if (beforeLabel && isCosmetic(beforeLabel, afterLabel)) break; // a tidy-up, not news
          // A DIFFERENT PIECE OF GEAR, said definitely rather than guessed: the row
          // now points at another catalog product, or its maker changed. Both are
          // facts carried in the patch. Deliberately NO string-similarity fallback —
          // a threshold would eventually assert a swap that never happened, and a
          // wrong "Swapped" is worse than a vague "Renamed".
          const relinked = typeof p.catalogItemId === "number" && p.catalogItemId !== was?.catalogItemId;
          const rebranded =
            typeof p.brand === "string" &&
            !!was?.brand &&
            // letters(), not the plain fold: "Arcteryx" → "Arc'teryx" is the same
            // maker, and the loose fold splits it on the apostrophe. Reachable only
            // when the name changed too — a punctuation-only fix exits above.
            letters(p.brand) !== letters(was.brand);
          const both = beforeLabel && afterLabel;
          if (relinked || rebranded) swapped.add(both ? `${beforeLabel} for ${afterLabel}` : undefined);
          else renamed.add(both ? `${beforeLabel} → ${afterLabel}` : undefined);
          break;
        }
        if (p.unitWeightMg !== undefined || p.entryUnit !== undefined) {
          reweighed.add(labelOf(op.id));
          break;
        }
        if (p.classification !== undefined || p.wornQty !== undefined || p.kcal !== undefined) {
          reclassified.add(labelOf(op.id));
          break;
        }
        if (p.personId !== undefined) {
          const n = labelOf(op.id);
          // the receiving person, when the batch names one that existed before it —
          // null (back up for grabs) or a just-added person reads as the bare item
          const to = typeof p.personId === "string" ? peopleById.get(p.personId)?.name : undefined;
          reassigned.add(n && to ? `${n} to ${to}` : n);
          break;
        }
        if (p.packed !== undefined) {
          packed.add();
          break;
        }
        other.add();
        break;
      }
      default:
        other.add();
    }
  }

  // Structural changes lead: they are what you would scan this list to find.
  if (added.n && !removed.n) return `Added ${added.one("item")}`;
  if (removed.n && !added.n) return `Removed ${removed.one("item")}`;
  if (added.n && removed.n) return `Added ${added.n}, removed ${removed.n}`;
  if (foldersAdded.n && !foldersRemoved.n) return `Added ${foldersAdded.one("folder")}`;
  if (foldersRemoved.n) return `Removed ${foldersRemoved.one("folder")}`;
  // A day is to the trip what a folder is to the list — a structural change, so it reads
  // at the same level rather than falling through to a generic "Edited the list".
  if (daysAdded.n && !daysRemoved.n) return `Added ${plural(daysAdded.n, "day")}`;
  if (daysRemoved.n) return `Removed ${plural(daysRemoved.n, "day")}`;
  if (daysEdited.n) return `Edited ${plural(daysEdited.n, "day")}`;
  // Below the days, because a recovery point is most often reached for after losing gear
  // or an itinerary; a moved pin is the smaller thing to have lost.
  if (wpsAdded.n && !wpsRemoved.n) return `Added ${plural(wpsAdded.n, "waypoint")}`;
  if (wpsRemoved.n) return `Removed ${plural(wpsRemoved.n, "waypoint")}`;
  if (wpsEdited.n) return `Edited ${plural(wpsEdited.n, "waypoint")}`;
  // The crew reads at the same structural level as days: who's on the trip is
  // list shape, not an item edit. "to/from the trip" keeps "Added Sam" from
  // reading as a gear row named Sam.
  if (peopleAdded.n && !peopleRemoved.n)
    return `Added ${peopleAdded.only() ?? persons(peopleAdded.n)} to the trip`;
  if (peopleRemoved.n) return `Removed ${peopleRemoved.only() ?? persons(peopleRemoved.n)} from the trip`;
  if (peopleEdited.n) {
    const rename = peopleEdited.only();
    return rename ? `Renamed ${rename}` : `Edited ${persons(peopleEdited.n)}`;
  }

  // then the single-intent edits
  const labelEdits = renamed.n + swapped.n + reweighed.n + reclassified.n + reassigned.n;
  if (swapped.n && labelEdits === swapped.n) return `Swapped ${swapped.one("item")}`;
  if (renamed.n && labelEdits === renamed.n) return `Renamed ${renamed.one("item")}`;
  if (reweighed.n && labelEdits === reweighed.n) {
    const name = reweighed.only();
    return name ? `Changed ${name}’s weight` : `Changed ${plural(reweighed.n, "weight")}`;
  }
  if (reclassified.n && labelEdits === reclassified.n) return `Reclassified ${reclassified.one("item")}`;
  if (reassigned.n && labelEdits === reassigned.n) return `Reassigned ${reassigned.one("item")}`;
  if (moved.n && !labelEdits) return `Moved ${moved.one("item")}`;
  // packing ticks are their own kind of session and shouldn't read as "edited"
  if (packed.n && !labelEdits) return `Checked off ${plural(packed.n, "item")}`;
  if (meta.n && !labelEdits) return "Changed list details";

  // a genuine mixture — say how much, since which is no longer one phrase
  const touched = labelEdits + moved.n + packed.n + other.n;
  return touched ? `Edited ${plural(touched, "item")}` : "";
}
