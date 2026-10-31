import { onBeforeUnmount, ref, type Ref } from "vue";

/**
 * A thing that says itself and goes away — a line of text, usually; My Gear's undo
 * bar holds the removed row instead, so what's held is the caller's type.
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
 * becomes something to dismiss. An undo bar asks for longer.
 */
export function useToast<T = string>(ms = 2000): {
  toast: Ref<T | null>;
  flash: (msg: T) => void;
  /** take it down now — an undo that was taken, say */
  clear: () => void;
} {
  const toast = ref(null) as Ref<T | null>;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clear() {
    clearTimeout(timer);
    toast.value = null;
  }
  function flash(msg: T) {
    toast.value = msg;
    clearTimeout(timer);
    timer = setTimeout(() => (toast.value = null), ms);
  }

  onBeforeUnmount(() => clearTimeout(timer));
  return { toast, flash, clear };
}
