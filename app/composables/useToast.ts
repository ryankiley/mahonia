import { onBeforeUnmount, ref, type Ref } from "vue";

/**
 * A line of text that says itself and goes away. (An undo is a different object, one
 * that holds what to take back and waits while you point at it: useUndo + UndoBar.)
 *
 * For the actions that otherwise leave no trace: copying a link or a Markdown
 * export succeeds silently, and without a word on screen there is nothing to tell
 * you it worked. The downloads confirm here too, alongside the browser's own
 * download chrome.
 *
 * Per-component, NOT a singleton — two menus can each own one, and a toast
 * belongs to the surface that raised it. That also means the timer is cleared on
 * unmount, so a menu that closes mid-toast doesn't leave a timer writing to a ref
 * nobody is rendering.
 *
 * 2s: long enough to read four words, short enough that it is gone before it
 * becomes something to dismiss.
 */
export function useToast(ms = 2000): { toast: Ref<string | null>; flash: (msg: string) => void } {
  const toast = ref<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flash(msg: string) {
    toast.value = msg;
    clearTimeout(timer);
    timer = setTimeout(() => (toast.value = null), ms);
  }

  onBeforeUnmount(() => clearTimeout(timer));
  return { toast, flash };
}
