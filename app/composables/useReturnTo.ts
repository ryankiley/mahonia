// Where to send someone back to after they sign in.
//
// Signing in is never the thing you came to do — it's the toll on the way to
// something else. Landing on /account afterwards leaves you looking at a settings
// page with no route back to the list you were editing, and the site bar on that
// page carries no list navigation to recover with.
//
// NOT A QUERY PARAM, deliberately. The obvious shape is /account?next=<path>, and
// it would leak an edit token: editLinkPath (shared/links.ts) puts the token in the
// URL FRAGMENT — `/e/{shareCode}#{token}` — precisely because fragments are never
// sent to a server, never logged, and never travel in a Referer header. Round-tripping
// that path through a query string moves the token into all three. So the return path
// is stored locally and never enters a URL.
//
// localStorage, not sessionStorage: the magic-link flow leaves for an email client and
// usually comes back in a NEW TAB, which starts with empty sessionStorage. This is also
// not a new exposure — the device's edit tokens already live in localStorage (the
// "my lists" registry is where they're kept).

import { isSafeReturnPath } from "~~/shared/links";
import { forget, recall, remember as store } from "../utils/remember";

const KEY = "gear.returnto.v1";
// Long enough to read an email and come back, short enough that a path abandoned days
// ago can't hijack a later sign-in. Consumed once regardless.
const TTL_MS = 30 * 60 * 1000;

/** Paths there's no point returning to — you'd bounce straight back here. */
const NEVER = ["/account", "/auth/callback"];

export function useReturnTo() {
  /** Remember the page being left, if it's worth returning to. */
  function remember(path: string): void {
    if (!import.meta.client || !isSafeReturnPath(path)) return;
    if (NEVER.some((p) => path === p || path.startsWith(`${p}?`) || path.startsWith(`${p}#`))) return;
    // private mode / quota swallow the write — returning to /gear is a fine outcome, not an error
    store(KEY, JSON.stringify({ path, at: Date.now() }));
  }

  /**
   * Take the stored path, if there is a fresh and valid one. ONE SHOT: the entry is
   * cleared whether or not it's used, so a stale path can never redirect a later,
   * unrelated sign-in.
   */
  function take(): string | null {
    if (!import.meta.client) return null;
    const raw = recall(KEY);
    forget(KEY);
    if (!raw) return null;
    try {
      const { path, at } = JSON.parse(raw) as { path?: unknown; at?: unknown };
      if (typeof at !== "number" || Date.now() - at > TTL_MS) return null;
      return isSafeReturnPath(path) ? path : null;
    } catch {
      return null;
    }
  }

  /** Go back where they came from, or to `fallback` if there's nowhere to go. */
  async function resume(fallback: string): Promise<void> {
    await navigateTo(take() ?? fallback, { replace: true });
  }

  return { remember, take, resume };
}
