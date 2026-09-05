// Six aggregate tallies, nothing attached: a count of times, not of people — the Legal
// page's "cookieless, aggregate counts", extended from page views to a handful of
// in-app actions (Ryan, 2026-09-05, so that which parts of the app get used stops
// being a guess). Through @vercel/analytics' track, which the Nuxt module already
// loads; in dev it logs to the console, so a fresh checkout counts to itself. The
// names here are the whole vocabulary — add one here, not inline, so this list and
// the one on the Legal page can't drift.
import { track } from "@vercel/analytics";

export type TallyName =
  | "list_created"
  | "import"
  | "share_link_copied"
  | "packing_opened"
  | "trip_opened"
  | "sign_in";

export function tally(name: TallyName): void {
  if (!import.meta.client) return;
  try {
    track(name);
  } catch {
    // analytics is never load-bearing
  }
}
