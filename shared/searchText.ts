// The two text folds the app applies to what people type, kept apart from the catalog
// ranker on purpose. Both run on the editor's first load: the vault keys gear by the
// search fold (shared/vault.ts) and the autocomplete bolds its matches with the
// highlighter — while the ranker they used to sit beside (shared/catalogSearch.ts)
// only runs on the offline path, behind a dynamic import. A module is placed as a
// whole: when these lived in the ranker's file, one static import of `highlightParts`
// carried the trigram scorer, the tier cascade and the row merger onto every first
// load, for code nothing on that load calls. Pure + framework-agnostic (unit-tested).

import { foldApostrophes } from "./tidyText";

/** The shared text fold: NFD → strip diacritics → lowercase → non-alphanumerics
 *  collapse to single spaces → trim. Diacritics fold to their base letter (ä→a, ū→u)
 *  BEFORE the a–z0–9 strip, so an accented brand ("Fjällräven") folds identically to
 *  its plain spelling ("Fjallraven") and each finds the other. Without the fold the
 *  accent bytes drop to spaces, fragmenting the word. The Neon path mirrors this with
 *  unaccent() (see server/utils/catalog.ts). trigrams() and the tier/prefix helpers
 *  in shared/catalogSearch.ts all fold through this ONE function so they can never
 *  drift apart. */
export function foldForSearch(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Split a suggestion into matched / unmatched runs against what's been typed, so
 * the overlap can be rendered bold — the standard typeahead affordance. Each
 * whitespace token of the query is matched independently (so "hyperl wind" bolds
 * both), case-insensitively. Single characters are ignored: at one letter the
 * emphasis lands on half the alphabet and reads as noise. A purely fuzzy hit with
 * no literal overlap returns one plain run, which is correct — there is nothing
 * honest to point at.
 *
 * The highlight has to agree with whatever decided the row was a match, and two
 * surfaces render it (the item autocomplete and the vault's own search): one copy,
 * so a second can't drift.
 */
/**
 * The search folds this highlighter can afford: apostrophes AND diacritics, both
 * applied ONE CHARACTER FOR ONE so an offset into the folded string is the same offset
 * into the original.
 *
 * foldForSearch above can't be reused here — it deletes and re-spaces, so its offsets
 * mean nothing against `text`. But leaving diacritics unfolded left exactly the hole the
 * apostrophe fold was added to close: typing "fjallraven" ranks Fjällräven (foldForSearch
 * strips the marks, and its own comment names that case) and then rendered the row with
 * nothing bolded, which reads as "this isn't the match you asked for".
 *
 * A character whose fold isn't one character — a lone combining mark, a surrogate half —
 * is kept as it was, because holding the 1:1 offsets matters more than matching it.
 */
const foldForHighlight = (raw: string): string =>
  foldApostrophes(raw).replace(/[^\u0000-\u007F]/g, (ch) => {
    const folded = ch.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return folded.length === 1 ? folded : ch;
  });

export function highlightParts(text: string, rawQuery: string): { t: string; on: boolean }[] {
  // Apostrophes folded on BOTH sides, and the offsets still index `text` — the fold is
  // 1:1 on characters, so position i in `lower` is position i in `text`. Rows are
  // stored tidied ("Arc’teryx") while the keyboard types "arc'te", and this is a
  // literal indexOf: without the fold the row still RANKS (the trigram fold ignores
  // punctuation) and still appears, but arrives with nothing bolded, which reads as
  // "this isn't the match you asked for".
  const q = foldForHighlight((rawQuery ?? "").trim().toLowerCase());
  const tokens = q.split(/\s+/).filter((t) => t.length > 1);
  if (!tokens.length) return [{ t: text, on: false }];
  const lower = foldForHighlight(text.toLowerCase());
  const hit = new Array(text.length).fill(false);
  for (const tok of tokens) {
    let from = 0;
    for (let idx = lower.indexOf(tok, from); idx !== -1; idx = lower.indexOf(tok, from)) {
      for (let i = idx; i < idx + tok.length; i++) hit[i] = true;
      from = idx + tok.length;
    }
  }
  const parts: { t: string; on: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.on === hit[i]) last.t += text[i];
    else parts.push({ t: text[i]!, on: hit[i] });
  }
  return parts;
}
