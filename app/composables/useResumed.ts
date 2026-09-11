import { resumeTarget } from "~~/shared/switcher";
import { claimedOpens } from "./useClaimedLists";

// The share code of the list the bare address just resumed, set by /
// (app/pages/index.vue) and read by the editor to aim the switcher's hint at the
// list you were dropped into. In-memory app state: it must not survive a reload of
// the list's own URL, which is not a resume.
export const useResumed = () => useState<string | null>("resumed-list", () => null);

/**
 * Where the bare address lands right now: this browser's registry ranked against
 * its claimed opens (shared/switcher resumeTarget), with ONE gate in front of the
 * claimed half — the readable session-hint cookie.
 *
 * A claimed open is only as good as the session behind it, and the editor's route
 * watcher will not even ask the server without the hint: it lands the address on
 * the keyless dead-end instead, "missing" with no verdict. Ranking those entries
 * anyway sent a lapsed session's launch there; the dead-resume watcher then took
 * the keyless "missing" for a dead list and forgot the entry, and because
 * dispose()+startKeyless() flip the status inside one tick, the second hop never
 * woke it at all — stranded on a dead-end for a list never chosen, one ledger entry
 * lost per launch. SKIPPED here, not forgotten: the hint comes back with the next
 * sign-in, and so does where you left off.
 *
 * `except` leaves one code out of the ranking — the list a resume has just found
 * dead — so the next hop can never be the address it is leaving, whether or not the
 * storage write behind forgetClaimedOpen went through.
 *
 * One function for the three places that used to spell the pair by hand: a call
 * that forgot the second argument silently regressed to the registry-only ranking,
 * and the gate would have had to be pasted three times.
 */
export function resumeHere(except?: string): { to: string; shareCode: string } | null {
  const claimed = useSession().hasSessionHint()
    ? claimedOpens().filter((c) => c.shareCode !== except)
    : [];
  return resumeTarget(useMyLists().entries.value, claimed);
}
