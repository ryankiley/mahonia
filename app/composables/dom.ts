import type { EffectScope, Ref } from "vue";

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

// Dismiss an anchored surface when a touch drag scrolls the page under it — the
// mobile companion to onClickOutside above. Menus hang off triggers that are often
// STICKY (the topbar's ⋯ and account controls, the editor toolbar's), so scrolling
// neither carries them away nor takes them down: the card just sits over the content
// you were trying to read, and the only way out is to find dead space and tap it. On
// a phone a menu is a good fraction of the screen, so scrolling past it is the
// natural gesture and it should mean what it plainly looks like it means.
//
// TOUCHMOVE, not scroll. Two reasons, and the second is the one that decided it:
//   - it IS the mobile predicate, so there's no media query to keep in step with the
//     rest of the app. A hybrid laptop dismisses when scrolled by finger and not when
//     scrolled by wheel, which is the behaviour you'd want on it anyway.
//   - a `scroll` listener fires on scrolls nobody performed. iOS scrolls the page to
//     clear the on-screen keyboard whenever a field takes focus, and the lists
//     switcher focuses its filter input the moment it opens — so it would have closed
//     itself, every time, on the exact device this exists for.
//
// Bound only WHILE open, like Tooltip's own scroll dismissal and for the same reason:
// this fires many times per gesture, and a menu nobody opened shouldn't pay for it.
// A drag INSIDE the surface is ignored — the switcher's list of lists is its own
// scroller, and scrolling it is the opposite of leaving.
export function onScrollOutside(
  open: Ref<boolean>,
  // same structural ref shape as onClickOutside, so template refs fit
  target: { readonly value: HTMLElement | null | undefined },
  handler: () => void,
): void {
  if (!import.meta.client) return;
  // capture, so a drag over any nested scroller is heard too
  const opts = { passive: true, capture: true } as const;
  const onTouchMove = (e: TouchEvent) => {
    const el = target.value;
    if (el && e.composedPath().includes(el)) return;
    handler();
  };
  const bind = (on: boolean) => {
    if (on) window.addEventListener("touchmove", onTouchMove, opts);
    else window.removeEventListener("touchmove", onTouchMove, opts);
  };
  watch(open, bind);
  onScopeDispose(() => bind(false));
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

// The three ways an open popover gets dismissed, wired in one call.
//
// Every menu in the app wants exactly the same set — an outside click, a scroll
// gesture, Escape — and each was writing all three out by hand, identically, in
// six places. The primitives above were always used correctly; it was the
// COMBINATION that had no home, so "how does a menu close" was six copies of an
// answer instead of one.
//
// The scroll listener is mobile's, and is the one most easily forgotten: these
// menus hang off sticky chrome, so on a touchscreen nothing about scrolling
// would otherwise take them down — the menu just rides along, parked over the
// list. It binds only while open (see onScrollOutside).
//
// The click-outside pair and Escape bind only while open too, in an effect scope
// started on open and stopped on close (ItemInput's own outside-click wiring is
// the model). They used to be bound for the instance's whole life, with the guard
// on `open` inside the handler — fine for the five toolbar menus this was written
// for, and wrong once every editable row mounted an OptionMenu for its unit: a
// 150-row list carried ~450 always-on window listeners, each walking
// composedPath() on every tap and keystroke to close a menu that wasn't open.
// The scope attaches after the opening click has fully dispatched (the watch runs
// on the microtask), so the press that opened the menu can never be the press
// that closes it.
//
// `onDismiss` is for a menu that has more to put away than the flag — the list
// switcher also clears the search it was filtered by, so reopening it doesn't
// start half-scrolled through yesterday's query. Omit it and closing is just the
// flag, which is what most of them want.
export function useMenuDismiss(
  open: Ref<boolean>,
  // same structural ref shape the primitives take, so template refs fit
  target: { readonly value: HTMLElement | null | undefined },
  onDismiss?: () => void,
): void {
  const close = onDismiss ?? (() => (open.value = false));
  onScrollOutside(open, target, close);
  let scope: EffectScope | null = null;
  const bind = (on: boolean) => {
    if (on && !scope) {
      scope = effectScope(true);
      scope.run(() => {
        onClickOutside(target, () => close());
        useWindowEvent("keydown", (e) => {
          if (e.key === "Escape") close();
        });
      });
    } else if (!on && scope) {
      scope.stop();
      scope = null;
    }
  };
  watch(open, bind);
  onScopeDispose(() => bind(false));
}
