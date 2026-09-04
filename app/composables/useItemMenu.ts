// One-at-a-time overflow menu for item rows. A singleton (like useItemDnd) so the
// whole list shares ONE open-menu id and ONE set of dismiss listeners — opening a
// row's ⋯ menu closes any other, and there are 3 window listeners total instead of
// the per-row set a naive useMenuDismiss would attach to every row. Editor-only
// (ItemRow renders client-side under GearEditor.client), but guarded anyway.

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const openId = ref<string | null>(null);
  // the open menu's root element, for outside-click detection (only one is ever open)
  let rootEl: HTMLElement | null = null;

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
    // The same outside-click / scroll-gesture / Escape trio every other menu gets
    // from useMenuDismiss. This is a page-lifetime singleton with no component
    // scope for those listeners to hang off, so a detached effect scope stands in
    // for one — it is never disposed, which is exactly the lifetime wanted.
    const open = computed(() => openId.value != null);
    const target = {
      get value() {
        return rootEl;
      },
    };
    effectScope(true).run(() => useMenuDismiss(open, target, close));
  }

  return { openId, toggle, close };
}

export function useItemMenu() {
  return (singleton ??= create());
}
