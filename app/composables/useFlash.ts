// A tiny self-expiring toast: flash("Link copied") shows the message for 2 s.
// The toast-ref + timer pair that the editor kebab and the read views' menu both
// hand to useListExports — extracted so the timing, reset and teardown can't
// drift between them (they were byte-identical copies). Each caller renders its
// own <Transition name="toast"> element off the returned ref.
export function useFlash() {
  const toast = ref("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  function flash(msg: string) {
    toast.value = msg;
    clearTimeout(timer);
    timer = setTimeout(() => (toast.value = ""), 2000);
  }
  onScopeDispose(() => clearTimeout(timer));
  return { toast, flash };
}
