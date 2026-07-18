// One-at-a-time overflow menu for item rows. A singleton (like useItemDnd) so the
// whole list shares ONE open-menu id and ONE set of dismiss listeners — opening a
// row's ⋯ menu closes any other, and there are 3 window listeners total instead of
// the per-row pair a naive onClickOutside would attach to every row. Editor-only
// (ItemRow renders client-side under GearEditor.client), but guarded anyway.

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const openId = ref<string | null>(null);
  // the open menu's root element, for outside-click detection (only one is ever open)
  let rootEl: HTMLElement | null = null;
  // the press must START outside too — a drag from inside the menu that releases
  // outside is not an outside click (same rule as dom.ts onClickOutside)
  let startedOutside = true;

  function close() {
    openId.value = null;
    rootEl = null;
  }
  function toggle(id: string, el: HTMLElement | null) {
    if (openId.value === id) close();
    else {
      openId.value = id;
      rootEl = el;
    }
  }

  if (import.meta.client) {
    // no-op <html> click listener so iOS Safari synthesizes clicks on non-interactive
    // dead space at all (WebKit only dispatches them when an ancestor looks clickable)
    // — without it, an outside tap can't dismiss the menu (mirrors dom.ts's shim)
    document.documentElement.addEventListener("click", () => {}, { passive: true });
    window.addEventListener(
      "pointerdown",
      (e) => {
        startedOutside = !rootEl || !e.composedPath().includes(rootEl);
      },
      { passive: true },
    );
    window.addEventListener(
      "click",
      (e) => {
        if (!rootEl || e.composedPath().includes(rootEl)) return;
        if (startedOutside) close();
      },
      // capture: still close when the outside click's own handler stops propagation
      { passive: true, capture: true },
    );
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  }

  return { openId, toggle, close };
}

export function useItemMenu() {
  return (singleton ??= create());
}
