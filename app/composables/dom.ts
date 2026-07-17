import type { Ref } from "vue";

// Hand-rolled stand-ins for the six @vueuse/core helpers the app actually
// called (useEventListener, onKeyStroke, onClickOutside, useNow, useOnline —
// plus useStorage, folded into useMyLists). The library backed those few call
// shapes with ~3 KB brotli of the entry chunk; these cover exactly the
// signatures the app uses. Note the window-less API: @vueuse/nuxt compiled a
// bare `window` argument to `undefined` in the server build, and without that
// module an SSR-rendered component (the /s and /l read views) would throw on
// it — so the window reference lives HERE, behind import.meta.client, and
// callers never touch it.

// Window listener bound to the component scope (auto-removed on unmount).
export function useWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  handler: (e: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions,
): void {
  if (!import.meta.client) return;
  window.addEventListener(type, handler, options);
  onScopeDispose(() => window.removeEventListener(type, handler, options));
}

export function onKeyStroke(key: string, handler: (e: KeyboardEvent) => void): void {
  useWindowEvent("keydown", (e) => {
    if (e.key === key) handler(e);
  });
}

// Fire when a click lands outside `target`. Two vueuse behaviors are kept
// deliberately: the press must START outside too (dragging from inside a menu
// and releasing outside is not an outside click), and a no-op click listener
// sits on <html> so iOS Safari synthesizes click events for taps on
// non-interactive dead space at all (WebKit only dispatches them when an
// ancestor looks clickable) — without it, outside taps can't close the menus.
let iosClickShim = false;
export function onClickOutside(
  // structural ref shape so plain refs and (readonly) template refs both fit
  target: { readonly value: HTMLElement | null | undefined },
  handler: (e: MouseEvent) => void,
): void {
  if (!import.meta.client) return;
  if (!iosClickShim) {
    iosClickShim = true;
    document.documentElement.addEventListener("click", () => {}, { passive: true });
  }
  let startedOutside = true;
  useWindowEvent(
    "pointerdown",
    (e) => {
      const el = target.value;
      startedOutside = !!el && !e.composedPath().includes(el);
    },
    { passive: true },
  );
  useWindowEvent(
    "click",
    (e) => {
      const el = target.value;
      if (!el || e.composedPath().includes(el)) return;
      if (startedOutside) handler(e);
    },
    // capture: still close when the outside click's own handler stops propagation
    { passive: true, capture: true },
  );
}

// navigator.onLine as a ref, tracked via the online/offline events. Lives in
// the editor's sync controller (client-only); a server render reads as online.
export function useOnline(): Ref<boolean> {
  const online = ref(import.meta.client ? navigator.onLine : true);
  useWindowEvent("online", () => (online.value = true));
  useWindowEvent("offline", () => (online.value = false));
  return online;
}

// A Date that re-renders consumers every `interval` ms (drives the ticking
// "x minutes ago" labels). On the server it's a frozen SSR-time Date, same as
// vueuse's — the client re-labels from its own clock after hydration.
export function useNow(opts: { interval: number }): Ref<Date> {
  const now = ref(new Date());
  if (import.meta.client) {
    const id = setInterval(() => (now.value = new Date()), opts.interval);
    onScopeDispose(() => clearInterval(id));
  }
  return now;
}
