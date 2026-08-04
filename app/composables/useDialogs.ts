import { reactive } from "vue";

// App-wide dialogs that replace the browser's native confirm()/prompt(): a
// promise-based confirm and a copy-link fallback (shown when the async Clipboard
// write is blocked, so a copy action never dead-ends). One shared reactive state
// drives a single <AppDialogs> mount (in app.vue), so any component can open a
// dialog without wiring its own modal. Module-level singleton — the same pattern
// as useMyLists; only ever mutated client-side, so SSR always renders it closed.

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // destructive actions read the confirm as the emphasised (primary) button and
  // say so in its label; the chrome is monochrome, so wording carries the weight.
  danger?: boolean;
  // An optional second decision, asked INSIDE the same dialog rather than as a
  // follow-up one. Deleting an account used to ask twice — "delete your account?"
  // then "delete your lists too?" — and a second modal appearing after you have
  // already committed reads as a step you didn't finish rather than a choice.
  // Read the answer from `confirmState.checked` after the promise resolves true.
  checkbox?: { label: string; hint?: string; default?: boolean };
}

interface ConfirmState extends Required<Omit<ConfirmOptions, "danger" | "checkbox">> {
  open: boolean;
  danger: boolean;
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
  cancelLabel: "Cancel",
  danger: false,
  checkboxLabel: "",
  checkboxHint: "",
  checked: false,
});
let confirmResolve: ((ok: boolean) => void) | null = null;

const linkState = reactive({ open: false, title: "", url: "" });

export function useDialogs() {
  // Ask the user to confirm; resolves true on confirm, false on cancel/dismiss.
  // Replaces `if (!confirm(msg)) return` with `if (!(await confirm({ message })))`.
  function confirm(opts: ConfirmOptions): Promise<boolean> {
    // settle any dialog left hanging (shouldn't happen, but never strand a promise)
    confirmResolve?.(false);
    Object.assign(confirmState, {
      open: true,
      title: opts.title ?? "",
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? (opts.danger ? "Delete" : "Confirm"),
      cancelLabel: opts.cancelLabel ?? "Cancel",
      danger: opts.danger ?? false,
      checkboxLabel: opts.checkbox?.label ?? "",
      checkboxHint: opts.checkbox?.hint ?? "",
      // reset every time — a box left ticked by a previous dialog must never carry
      // into an unrelated one, least of all a destructive one
      checked: opts.checkbox?.default ?? false,
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
    Object.assign(linkState, { open: true, url, title });
  }
  function closeLinkFallback() {
    linkState.open = false;
  }

  return {
    confirmState,
    settleConfirm,
    confirm,
    linkState,
    showLinkFallback,
    closeLinkFallback,
  };
}
