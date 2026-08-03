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
// Pure + shared so the wording is written down once: the server stores it and the
// panel renders it verbatim, rather than each having a half-opinion about phrasing.

import type { Op } from "./ops";

/** Longer than this and it stops being a label. */
export const MAX_SUMMARY_LEN = 80;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Summarise a batch.
 *
 * ONE phrase, describing the dominant thing that happened rather than listing
 * everything: a batch is whatever was queued since the last flush, so it is usually
 * one intent ("added three things", "renamed something") and occasionally a mixture.
 * A mixture that resists summarising falls back to a count of touched rows, which is
 * still more than "Edited" said.
 *
 * Returns "" for a batch with nothing worth reporting — the caller keeps its own
 * default rather than storing an empty phrase.
 */
export function summarizeOps(ops: readonly Op[]): string {
  if (!ops.length) return "";

  let added = 0;
  let removed = 0;
  let foldersAdded = 0;
  let foldersRemoved = 0;
  let renamed = 0;
  let reweighed = 0;
  let reclassified = 0;
  let moved = 0;
  let packed = 0;
  let meta = 0;
  let other = 0;

  for (const op of ops) {
    switch (op.t) {
      case "addItem": added++; break;
      case "removeItem": removed++; break;
      case "addFolder": foldersAdded++; break;
      case "removeFolder": foldersRemoved++; break;
      case "moveItem": moved++; break;
      case "setMeta": meta++; break;
      case "updateFolder": other++; break;
      case "updateItem": {
        const p = op.patch ?? {};
        // Checked in the order a person would describe them. A patch usually carries
        // one intent; when it carries several, the first match wins rather than the
        // row being counted three times.
        if (typeof p.name === "string") renamed++;
        else if (p.unitWeightMg !== undefined || p.entryUnit !== undefined) reweighed++;
        else if (p.classification !== undefined || p.wornQty !== undefined || p.kcal !== undefined) reclassified++;
        else if (p.packed !== undefined) packed++;
        else other++;
        break;
      }
      default: other++;
    }
  }

  // Structural changes lead: they are what you would scan this list to find.
  if (added && !removed) return `Added ${plural(added, "item")}`;
  if (removed && !added) return `Removed ${plural(removed, "item")}`;
  if (added && removed) return `Added ${added}, removed ${removed}`;
  if (foldersAdded && !foldersRemoved) return `Added ${plural(foldersAdded, "folder")}`;
  if (foldersRemoved) return `Removed ${plural(foldersRemoved, "folder")}`;

  // then the single-intent edits
  if (renamed && !reweighed && !reclassified) return `Renamed ${plural(renamed, "item")}`;
  if (reweighed && !renamed && !reclassified) return `Changed ${plural(reweighed, "weight")}`;
  if (reclassified && !renamed && !reweighed) return `Reclassified ${plural(reclassified, "item")}`;
  if (moved && !renamed && !reweighed && !reclassified) return `Moved ${plural(moved, "item")}`;
  // packing ticks are their own kind of session and shouldn't read as "edited"
  if (packed && !renamed && !reweighed && !reclassified && !moved) return `Checked off ${plural(packed, "item")}`;
  if (meta && !renamed && !reweighed && !reclassified && !moved && !packed) return "Changed list details";

  // a genuine mixture — say how much, since which is no longer one phrase
  const touched = renamed + reweighed + reclassified + moved + packed + other;
  return touched ? `Edited ${plural(touched, "item")}` : "";
}
