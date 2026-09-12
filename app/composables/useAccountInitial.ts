// The letter on the account disc — and this device's memo of it.
//
// Signed in, the top bar's account control is a disc lettered with your initial
// (AccountMenu). The letter is the first character of the display name, or of the
// address while there is no name: an account cannot exist without an address, so
// there is always one, and the disc is never blank or a "?". An address is shown to
// no one but its owner, and this control is only ever the owner's own view of it —
// and one letter of it is all that leaves the session.
//
// THE MEMO is what puts the letter on the disc at first paint. The session plugin
// asks /api/auth/me at boot but nothing waits for the answer (see plugins/
// session.client.ts), so on every load the bar mounts a beat before it knows who is
// signed in. The hint cookie already carries "someone is" — the reason the menu
// shape is drawn without waiting (AccountMenu's `known`); this carries "and this is
// their letter", so the disc doesn't mount empty and fill in 200 ms later on every
// page, and offline with a hint — where /api/auth/me never answers — it stays
// lettered. A per-account memo like the vault's "already sent" and the registry's
// "already claimed": useSession's forgetAccountMemos drops all three on every way
// out of an account, so the next person to sign in here doesn't wear the last
// person's letter.

import type { ComputedRef } from "vue";

const KEY = "gear.account.initial.v1";

/** The one character the disc wears. Case is the stylesheet's job. */
export function accountInitial(user: { displayName: string | null; email: string | null }): string {
  return firstGrapheme(user.displayName?.trim() || user.email?.trim() || "");
}

// The first GRAPHEME, not the first code unit or code point: a trail name can open
// with a flag or a joined emoji, and a name typed or pasted in decomposed form opens
// with a base letter followed by its accent — `[0]` would show half a flag, the first
// person of a family, or the "e" of "é" without its mark. Intl.Segmenter is in every
// current browser; the code-point fallback is for the few that predate it.
function firstGrapheme(s: string): string {
  if (!s) return "";
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const [first] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s);
    return first?.segment ?? "";
  }
  return Array.from(s)[0] ?? "";
}

/** Drop the memo — part of forgetAccountMemos, run on every way out of an account. */
export function forgetAccountInitial(): void {
  if (!import.meta.client) return;
  forget(KEY);
}

/**
 * The letter for the disc: the session's own once /api/auth/me has answered, this
 * device's memo until then (and offline, where it never will), and "" on a browser
 * that has neither — the one beat before the first answer on a device that has never
 * kept the memo. Called from the control itself, so the memo is refreshed exactly
 * where it's read: every resolved session rewrites it, which is how a name changed
 * on another device reaches this one's disc.
 */
export function useAccountInitial(): ComputedRef<string> {
  const { user } = useSession();
  watch(
    user,
    (u) => {
      if (u) remember(KEY, accountInitial(u)); // a blocked write costs one empty beat next load, nothing more
    },
    { immediate: true },
  );
  return computed(() => (user.value ? accountInitial(user.value) : (recall(KEY) ?? "")));
}
