// The bare address is "where you left off". With lists on this device, open the one
// opened most recently; with none, fall through — the page renders a fresh draft
// right there, and /e keeps meaning "new". Decided here, in the browser, because the
// registry lives in localStorage — the server can't know — so the prerendered file
// and the SSR render are the same nothing for everyone.
//
// A NAMED middleware rather than a function inside the page's definePageMeta, and
// that is a loading decision: a function in the meta makes the routes table import
// the page's meta module statically, which puts this code — and the switcher module
// it reads — on the boot path of every route. A name is a string, and a named
// middleware is loaded only when the route that names it is entered.
//
// BOTH WAYS IN are ranked, which is what makes this right on the launch that has no
// network. A list this browser opened through the account rather than through an
// edit link leaves no registry row, so ranking the registry alone sent the installed
// app to whatever OTHER list happened to hold a token here — a list you last touched
// weeks ago, while the one you actually packed sat on the device unreachable from
// its own start_url. The ranking, and the one gate in front of its claimed half,
// live in resumeHere (app/composables/useResumed.ts), shared with the page and the
// editor's dead-resume skip.
import { resumeHere } from "~/composables/useResumed";

export default defineNuxtRouteMiddleware(() => {
  if (import.meta.server) return;
  const target = resumeHere();
  // Written on EVERY visit, cleared included: the editor aims its switcher hint at
  // the list the bare address dropped you into, and a code left over from an earlier
  // resume would make a deliberate open of that list read as another one.
  useResumed().value = target?.shareCode ?? null;
  if (!target) return; // nothing to go back to: the page is the draft
  return navigateTo(target.to, { replace: true });
});
