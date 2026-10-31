import { reactive } from "vue";

// The feedback box, opened over whatever you were doing — from the editor's ⋯ menu,
// the read views' ⋯ menu, and the read views' "Report list" (which is feedback about
// one list, with the message seeded).
//
// Module-level singleton driving ONE <FeedbackModal> mount in app.vue, the same shape
// as useAccountModal and useDialogs, so a surface opens it without wiring its own
// overlay: the editor and the read menu each carried the open/everOpened pair, the
// preset and the title, and a Lazy mount of their own. Only ever mutated client-side,
// from a click, so SSR always renders it closed — the RULE useAccountModal spells out
// (a module-level reactive is one variable the server shares across every request).
//
// `everOpened` gates the Lazy mount, so a visit that never has anything to say pays
// nothing for the box; `open` drives the transition once it's mounted.
const state = reactive({
  open: false,
  everOpened: false,
  /** what the box opens with — a report seeds both; plain feedback clears them */
  preset: undefined as string | undefined,
  title: undefined as string | undefined,
});

export function useFeedback() {
  function open(opts: { preset?: string; title?: string } = {}): void {
    state.preset = opts.preset;
    state.title = opts.title;
    state.everOpened = true;
    state.open = true;
  }
  function close(): void {
    state.open = false;
  }
  return { state, open, close };
}
