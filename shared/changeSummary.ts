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
import type { Folder, Item } from "./types";
import { itemDisplayName } from "./weights";
import { tidyText } from "./tidyText";
import type { Op } from "./ops";

/** Longer than this and it stops being a label. */
export const MAX_SUMMARY_LEN = 80;

/** The list as it stood before the batch — what makes names resolvable. */
export interface SummaryBefore {
  items: readonly Item[];
  folders: readonly Folder[];
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Name one thing, or count several.
 *
 * A history line is capped at MAX_SUMMARY_LEN and three gear names do not fit in
 * eighty characters — so naming is for the single case, which is also the case
 * where a name tells you something a count can't.
 */
const one = (names: readonly string[], n: number, noun: string) =>
  n === 1 && names.length === 1 ? names[0]! : plural(n, noun);

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
  const reportable = ops.filter((op) => !("quiet" in op && op.quiet));
  if (!reportable.length) return "";

  const itemsById = new Map((before?.items ?? []).map((i) => [i.id, i]));
  const foldersById = new Map((before?.folders ?? []).map((f) => [f.id, f]));
  const labelOf = (id: string) => {
    const it = itemsById.get(id);
    return it ? itemDisplayName(it.brand, it.name, it.variant) : "";
  };

  let added = 0, removed = 0, foldersAdded = 0, foldersRemoved = 0;
  let renamed = 0, swapped = 0, reweighed = 0, reclassified = 0, moved = 0, packed = 0;
  let meta = 0, other = 0;

  const addedNames: string[] = [];
  const removedNames: string[] = [];
  const renamedPhrases: string[] = [];
  const swappedPhrases: string[] = [];
  const reweighedNames: string[] = [];
  const reclassifiedNames: string[] = [];
  const movedPhrases: string[] = [];
  const folderNames: string[] = [];

  for (const op of reportable) {
    switch (op.t) {
      case "addItem": {
        added++;
        const n = itemDisplayName(op.item?.brand, op.item?.name, op.item?.variant);
        if (n) addedNames.push(n);
        break;
      }
      case "removeItem": {
        const n = labelOf(op.id);
        // A row with no name was never gear — it's a blank someone abandoned, and
        // "Removed" describes nothing. (The editor marks the ones it tidies away
        // itself with `quiet`; this catches any that reach here another way.)
        if (before && !n) break;
        removed++;
        if (n) removedNames.push(n);
        break;
      }
      case "addFolder":
        foldersAdded++;
        if (op.folder?.name) folderNames.push(op.folder.name);
        break;
      case "removeFolder": {
        foldersRemoved++;
        const f = foldersById.get(op.id);
        if (f?.name) folderNames.push(f.name);
        break;
      }
      case "moveItem": {
        moved++;
        const n = labelOf(op.id);
        const to = op.folderId ? foldersById.get(op.folderId)?.name : null;
        if (n && to) movedPhrases.push(`${n} to ${to}`);
        break;
      }
      case "setMeta":
        meta++;
        break;
      case "updateFolder":
        other++;
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
          if (relinked || rebranded) {
            swapped++;
            if (beforeLabel && afterLabel) swappedPhrases.push(`${beforeLabel} for ${afterLabel}`);
          } else {
            renamed++;
            if (beforeLabel && afterLabel) renamedPhrases.push(`${beforeLabel} → ${afterLabel}`);
          }
          break;
        }
        if (p.unitWeightMg !== undefined || p.entryUnit !== undefined) {
          reweighed++;
          const n = labelOf(op.id);
          if (n) reweighedNames.push(n);
          break;
        }
        if (p.classification !== undefined || p.wornQty !== undefined || p.kcal !== undefined) {
          reclassified++;
          const n = labelOf(op.id);
          if (n) reclassifiedNames.push(n);
          break;
        }
        if (p.packed !== undefined) {
          packed++;
          break;
        }
        other++;
        break;
      }
      default:
        other++;
    }
  }

  // Structural changes lead: they are what you would scan this list to find.
  if (added && !removed) return `Added ${one(addedNames, added, "item")}`;
  if (removed && !added) return `Removed ${one(removedNames, removed, "item")}`;
  if (added && removed) return `Added ${added}, removed ${removed}`;
  if (foldersAdded && !foldersRemoved) return `Added ${one(folderNames, foldersAdded, "folder")}`;
  if (foldersRemoved) return `Removed ${one(folderNames, foldersRemoved, "folder")}`;

  // then the single-intent edits
  const labelEdits = renamed + swapped + reweighed + reclassified;
  if (swapped && labelEdits === swapped)
    return swapped === 1 && swappedPhrases.length === 1
      ? `Swapped ${swappedPhrases[0]}`
      : `Swapped ${plural(swapped, "item")}`;
  if (renamed && labelEdits === renamed)
    return renamed === 1 && renamedPhrases.length === 1
      ? `Renamed ${renamedPhrases[0]}`
      : `Renamed ${plural(renamed, "item")}`;
  if (reweighed && labelEdits === reweighed)
    return reweighed === 1 && reweighedNames.length === 1
      ? `Changed ${reweighedNames[0]}’s weight`
      : `Changed ${plural(reweighed, "weight")}`;
  if (reclassified && labelEdits === reclassified)
    return `Reclassified ${one(reclassifiedNames, reclassified, "item")}`;
  if (moved && !labelEdits)
    return moved === 1 && movedPhrases.length === 1
      ? `Moved ${movedPhrases[0]}`
      : `Moved ${plural(moved, "item")}`;
  // packing ticks are their own kind of session and shouldn't read as "edited"
  if (packed && !labelEdits && !moved) return `Checked off ${plural(packed, "item")}`;
  if (meta && !labelEdits && !moved && !packed) return "Changed list details";

  // a genuine mixture — say how much, since which is no longer one phrase
  const touched = labelEdits + moved + packed + other;
  return touched ? `Edited ${plural(touched, "item")}` : "";
}
