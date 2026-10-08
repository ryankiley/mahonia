// The two text folds the app applies to what people type, kept apart from the catalog
// ranker on purpose. Both run on the editor's first load: the vault keys gear by the
// search fold (shared/vault.ts) and the autocomplete bolds its matches with the
// highlighter — while the ranker they used to sit beside (shared/catalogSearch.ts)
// only runs on the offline path, behind a dynamic import. A module is placed as a
// whole: when these lived in the ranker's file, one static import of `highlightParts`
// carried the trigram scorer, the tier cascade and the row merger onto every first
// load, for code nothing on that load calls. Pure + framework-agnostic (unit-tested).

import { foldApostrophes } from "./tidyText";

/** The shared text fold: NFD → strip the marks → lowercase → the few Latin letters NFD
 *  leaves whole take their plain spelling → anything that is not a letter or a digit,
 *  in any script, collapses to a single space → trim. Diacritics fold to their base letter
 *  (ä→a, ū→u) BEFORE the strip, so an accented brand ("Fjällräven") folds identically
 *  to its plain spelling ("Fjallraven") and each finds the other. Without the fold the
 *  accent bytes drop to spaces, fragmenting the word. ø, ß, æ, œ, ł, đ, ð and þ have no
 *  decomposition, so they are spelled out by hand (ø→o: "norrona" finds Norrøna), the
 *  same way Postgres's unaccent() spells them, which is what the Neon path folds with
 *  (see server/utils/catalog.ts). Letters outside Latin are letters too: a name in
 *  Chinese keeps every character, rather than folding to nothing, so gear named only in
 *  its owner's language has an identity (shared/vault.ts) and can be searched for.
 *  Width folds first (foldWidth). trigrams() and the tier/prefix helpers in
 *  shared/catalogSearch.ts all fold through this ONE function so they can never drift
 *  apart; the Neon query folds its width through foldWidth before the SQL, since
 *  unaccent() knows nothing of width. */
export function foldForSearch(input: string): string {
  return foldWidth(input)
    .normalize("NFD")
    // Every mark but the kana voicing marks: NFD splits ガ into カ + U+3099, and
    // stripping that would read "gas" as "dregs". They are the one mark that makes a
    // different word rather than a different spelling of the same one. NFC then
    // puts ガ back together, so the letter strip below sees a letter, not a mark.
    .replace(/(?![\u3099\u309a])[\p{M}\p{Diacritic}]/gu, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[øßæœłđðþ]/g, (ch) => UNDECOMPOSED[ch]!)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The width fold on its own: a Chinese or Japanese keyboard in full-width mode types
 * "ＭＳＲ" and "２" for MSR and 2, and a Japanese one may type half-width kana ("ｶﾒﾗ"),
 * so the full-width ASCII block maps onto ASCII and half-width kana onto the ordinary
 * kana (NFKC, applied to that block alone: whole-string NFKC would also spell "™" as
 * "tm" and split an identity on a trademark sign). Its own function because the
 * server's catalog query needs exactly this much and no more before the SQL: Postgres
 * does its own case fold and unaccent, but reads "ＭＳＲ" as three letters it has
 * never seen.
 */
export function foldWidth(input: string): string {
  return input
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\uff61-\uff9f]+/g, (run) => run.normalize("NFKC"));
}

/**
 * Is there enough typed to search on? Two characters: one is too noisy for trigrams.
 * Every surface that searches asks this ONE question — the catalog menu, the vault
 * pane, the page, and the server endpoints behind them — so none of them can say
 * "keep typing" while another answers. The exception is an ideograph: in Chinese a
 * single character is a word ("锅" is a pot), and two is a long query, so one of
 * those is a finished question and gets its answer.
 */
export function enoughToSearch(query: string): boolean {
  return query.length >= 2 || hasIdeograph(query);
}

/** Whether the text carries an ideograph (a Chinese character, or a kanji). One is a
 *  word, and two is a long one, so the length rules written for letters don't apply. */
export const hasIdeograph = (s: string): boolean => /\p{Ideographic}/u.test(s);

/** Whether the text carries kana. Two kana are a word ("なべ" is a pot), where two
 *  letters are a fragment; one kana alone is not, so this never opens a search. */
export const hasKana = (s: string): boolean => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s);

/** Latin letters that NFD leaves in one piece, and what unaccent() spells them as. */
const UNDECOMPOSED: Record<string, string> = {
  "ø": "o",
  "ß": "ss",
  "æ": "ae",
  "œ": "oe",
  "ł": "l",
  "đ": "d",
  "ð": "d",
  "þ": "th",
};

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
