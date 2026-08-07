// How a saved-list entry names itself wherever it's shown as a row rather than
// opened. One surface renders it now — the editor's list switcher — but it stays its
// own function rather than folding into that component: the editor's confirm dialogs
// name a list the same way ("Forget “Untitled list”…"), and a list that answered to
// two different names depending on whether you were switching to it or deleting it
// would be worse than the duplication.
//
// The TOTAL is deliberately not here. The retired /mine page showed one because it
// was a management view with room for it; a switcher doesn't, because beside a name
// it competed with the one thing you scan a switcher for.

/** An untitled list still needs a name in a list of names. */
export function savedListTitle(title: string): string {
  const n = title?.trim();
  return n && n !== "Untitled list" ? n : "Untitled list";
}
