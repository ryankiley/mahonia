import { reactive } from "vue";

// App-wide dialogs that replace the browser's native confirm()/prompt(): a
// promise-based confirm and a copy-link fallback (shown when the async Clipboard
// write is blocked, so a copy action never dead-ends), with copyLink, the one way a
// link is copied that ends in it. One shared reactive state
// drives a single <AppDialogs> mount (in AppOverlays), so any component can open a
// dialog without wiring its own modal. Module-level singleton — the same pattern
// as useMyLists; only ever mutated client-side, so SSR always renders it closed.
//
// That last clause is a RULE and the only thing keeping it safe: a module-level
// reactive is one variable a long-running server shares across every request. Every
// mutator here hangs off a click or a promise settled by one, so the server never
// touches it — but open a dialog from setup-time logic and one visitor's modal is in
// another's SSR'd HTML. The state could move to useState; `confirmResolve` below
// could not, being a live promise resolver, and doesn't need to — it is only ever set
// on the client, and on the server there is nothing pending to resolve.

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  // An optional second decision, asked INSIDE the same dialog rather than as a
  // follow-up one. Deleting an account used to ask twice — "delete your account?"
  // then "delete your lists too?" — and a second modal appearing after you have
  // already committed reads as a step you didn't finish rather than a choice.
  // Read the answer from `confirmState.checked` after the promise resolves true.
  checkbox?: { label: string; hint?: string };
}

interface ConfirmState extends Required<Omit<ConfirmOptions, "checkbox">> {
  open: boolean;
  checkboxLabel: string;
  checkboxHint: string;
  /** The checkbox's answer. Only meaningful when checkboxLabel is set. */
  checked: boolean;
}

const confirmState = reactive<ConfirmState>({
  open: false,
  title: "",
  message: "",
  confirmLabel: "Confirm",
  checkboxLabel: "",
  checkboxHint: "",
  checked: false,
});
let confirmResolve: ((ok: boolean) => void) | null = null;

const linkState = reactive({ open: false, title: "", url: "" });

// `everOpened` gates the <LazyAppDialogs> mount in AppOverlays, the way useAccountModal's
// gates <LazyAccountModal>: both dialogs open on a click and nothing else, so a visit
// that never confirms anything and never has a copy blocked pays nothing for them.
// Latched, never cleared — once mounted the component stays, so every close after
// the first still gets its leave transition (BaseModal's `appear` covers the first
// open, which lands already open).
const mount = reactive({ everOpened: false });

export function useDialogs() {
  // Ask the user to confirm; resolves true on confirm, false on cancel/dismiss.
  // Replaces `if (!confirm(msg)) return` with `if (!(await confirm({ message })))`.
  function confirm(opts: ConfirmOptions): Promise<boolean> {
    // settle any dialog left hanging (shouldn't happen, but never strand a promise)
    confirmResolve?.(false);
    mount.everOpened = true;
    Object.assign(confirmState, {
      open: true,
      title: opts.title ?? "",
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "Confirm",
      checkboxLabel: opts.checkbox?.label ?? "",
      checkboxHint: opts.checkbox?.hint ?? "",
      // reset every time — a box left ticked by a previous dialog must never carry
      // into an unrelated one, least of all a destructive one
      checked: false,
    });
    return new Promise<boolean>((res) => (confirmResolve = res));
  }
  function settleConfirm(ok: boolean) {
    confirmState.open = false;
    confirmResolve?.(ok);
    confirmResolve = null;
  }

  // Fallback when a clipboard write is blocked: show the link in a read-only,
  // pre-selected field so it can be copied by hand instead of silently failing.
  function showLinkFallback(url: string, title = "Copy this link") {
    mount.everOpened = true;
    Object.assign(linkState, { open: true, url, title });
  }
  function closeLinkFallback() {
    linkState.open = false;
  }

  /**
   * Copy a link from inside a click, and say how it went: `done` in the toast when it
   * landed, the link shown to copy by hand when the clipboard refused it (titled
   * `title`), and a line saying so when a link being made by the same click never came.
   * A link already known is copied the plain way (copyText); one still being made (a
   * draft list's first save, My Gear's link turned on) is handed over as a promise, and
   * its write starts now (copyTextWhen), so the wait doesn't spend the click. Resolves
   * to whether there was a link, copied or shown.
   *
   * The editor's links, a read view's and My Gear's all came through three copies of
   * this; the toast is still the caller's, passed in as `flash`.
   */
  async function copyLink(
    link: string | Promise<string>,
    say: { flash: (msg: string) => void; done: string; title: string },
  ): Promise<boolean> {
    let text: string;
    let copied: boolean;
    if (typeof link === "string") {
      text = link;
      copied = await copyText(link);
    } else {
      copied = await copyTextWhen(link);
      text = await link.catch(() => "");
      if (!text) {
        say.flash("Couldn’t make the link. Try again.");
        return false;
      }
    }
    if (copied) say.flash(say.done);
    else showLinkFallback(text, say.title);
    return true;
  }

  return {
    confirmState,
    settleConfirm,
    confirm,
    linkState,
    showLinkFallback,
    closeLinkFallback,
    copyLink,
    mount,
  };
}
