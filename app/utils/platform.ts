// What to CALL the modifier keys, per platform.
//
// The shortcuts sheet exists so a gesture nobody could guess becomes findable, which it
// fails at the moment it names a key the reader's keyboard doesn't have. "Alt" is the
// right word almost everywhere and the wrong one on a Mac, where the key is Option and
// is printed ⌥ — so a Mac reader is told to press something they have to translate
// first, in the one place whose whole job is not making them do that.
//
// CLIENT-ONLY by construction. Both readers (the editor's shortcuts sheet and an item
// row's grip tooltip) render inside GearEditor.client.vue and never run on the server,
// so this reads `navigator` directly rather than growing a ref that hydrates. It falls
// back to "Alt" if asked anywhere else, which is the safe half of the guess: a
// non-Mac name shown on a Mac is a translation, where ⌥ shown on Windows is a symbol
// with no key at all.
//
// userAgentData.platform first (navigator.platform is deprecated and lies under some
// emulation), then the old field, then nothing.
//
// AND AN IPAD IS NOT A MAC, however loudly it says so. iPadOS Safari ships no
// userAgentData and reports navigator.platform as "MacIntel" — so the string test
// alone hands an iPad a sheet written in ⌥, a key it does not have, which is the exact
// failure this module exists to prevent. maxTouchPoints separates them: a Mac reports
// 0 (1 on a touch-bar model), an iPad 5.
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  if (navigator.maxTouchPoints > 1) return false;
  const p =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac/i.test(p);
}

/** The Alt/Option key's name here — "⌥" on a Mac, "Alt" everywhere else. */
export const altKeyLabel = (): string => (isMac() ? "⌥" : "Alt");
