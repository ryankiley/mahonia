// How a saved-list entry names itself wherever it's shown as a row rather than
// opened. Two surfaces render it — the "Your lists" page (/mine) and the editor's
// list switcher — and both have to agree on what an untitled list is called, or the
// same list appears under two names depending on where you're looking at it.
//
// The TOTAL is deliberately not here. /mine shows one because it's a management
// view with room for it; the switcher doesn't, because beside a name it competed
// with the one thing you scan a switcher for.

/** An untitled list still needs a name in a list of names. */
export function savedListTitle(title: string): string {
  const n = title?.trim();
  return n && n !== "Untitled list" ? n : "Untitled list";
}
