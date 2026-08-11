import { reactive } from "vue";

// The account, opened over whatever you were doing.
//
// Signing in is a toll on the way to something else — it is almost never the errand
// you set out on. Sending you to /account to pay it took your list off the screen and
// left you on a settings page whose top bar carries no list navigation to leave with,
// which is exactly how people described it: lost.
//
// Module-level singleton driving ONE <AccountModal> mount in app.vue — the same shape
// as useDialogs, so any component can open the account without wiring its own overlay.
// Only ever mutated client-side, so SSR always renders it closed.
//
// THAT LAST SENTENCE IS A RULE, not an observation, and it is the only thing keeping
// this safe. A module-level reactive is one variable shared by a long-running server
// process across every request it serves. Every mutator here is reached from a click,
// so the server never touches it — but open this from a `watch`, a `computed`, or
// plain setup-time logic (auto-opening on a `?signin` query param is the obvious way
// in) and one visitor's modal state lands in another visitor's SSR'd HTML. If that
// ever needs to happen, this moves to useState first, the way useReadView already has
// — that one backs the indexable read pages, so it could not be left on a convention.
//
// /account still exists and is not a redirect: a bookmark, a typed URL and the dead
// magic link's "Get a new link" all arrive with nothing underneath to sit on top of.
// Both mounts render AccountView, so there is one implementation of the thing itself.

// `everOpened` gates the <LazyAccountModal> mount so the account's chunk — the panel,
// the passkey ceremony, the delete flow — is fetched on the first open and never on a
// load that doesn't need it. `open` drives the transition once it's mounted. Same two-
// flag shape as the editor's Lazy modals.
const state = reactive({ open: false, everOpened: false });

export function useAccountModal() {
  function open(): void {
    state.everOpened = true;
    state.open = true;
  }
  function close(): void {
    state.open = false;
  }
  return { state, open, close };
}
