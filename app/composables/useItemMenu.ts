// One-at-a-time overflow menu for item rows. A singleton (like useItemDnd) so the
// whole list shares ONE open-menu id and ONE set of dismiss listeners — opening a
// row's ⋯ menu closes any other, and the listeners are bound once for the list rather
// than once per row. Editor-only (ItemRow renders client-side under GearEditor.client).

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const openId = ref<string | null>(null);
  // the open menu's root element, which a press, a drag or focus is inside or outside
  // of (only one is ever open)
  const root = shallowRef<HTMLElement | null>(null);

  function close() {
    openId.value = null;
    root.value = null;
  }
  function toggle(id: string, el: HTMLElement | null) {
    if (openId.value === id) close();
    else {
      openId.value = id;
      root.value = el;
    }
  }

  // How it closes is useMenuDismiss's, the one every other menu uses: an outside click,
  // a touch drag past it, and Escape, which closes the popover and nothing around it.
  // These listeners were once written out here, and their Escape never marked the key
  // handled, so with My Gear open beside the list it closed the pane as well.
  //
  // In a DETACHED scope, for the reason useEditorMode has one: the first caller is
  // whichever row mounts first, and that row unmounting must not take the whole list's
  // dismissal with it.
  const open = computed(() => openId.value !== null);
  effectScope(true).run(() => useMenuDismiss(open, root, close));

  return { openId, toggle, close };
}

export function useItemMenu() {
  return (singleton ??= create());
}
