import type { Ref } from "vue";

// Per-id collapse state that outlives the page — a folder, a nested group, a trip
// day — kept in localStorage under `${prefix}${id}`.
//
// Pure UI state, never sent to the server: it's how YOU are looking at the list, not a
// fact about it. Four surfaces remember a collapse this way (the editor's folders and
// nested groups, /gear's sections, the plan's days), and each carried its own copy of
// the read, the write and the storage fallback; this is that copy, once. Every caller
// keeps its own key namespace — gear.fold.*, gear.nest.*, gear.vkind.*, gear.day.* —
// so nobody's remembered state moved when the code did.
//
// Read straight off storage: each caller reads once on mount, a few hundred reads cost
// a fraction of a millisecond, and a value read from disk is never stale when the same
// list is open in another tab.
export function usePersistedCollapse(prefix: string) {
  const keyFor = (id: string | number) => `${prefix}${id}`;

  /** Collapsed? Storage blocked (private mode) answers false — default expanded — the
   *  same as every caller decided. recall() (app/utils/remember) answers null there. */
  function isCollapsed(id: string | number): boolean {
    return recall(keyFor(id)) === "1";
  }

  /** Record it. "1" collapsed; an absent key is expanded, so collapsing back open
   *  drops the key rather than writing a "0" that reads the same. */
  function set(id: string | number, on: boolean): void {
    const key = keyFor(id);
    if (on) remember(key, "1");
    else forget(key);
  }

  /**
   * One row's collapse as a ref, for a component that owns a single id (a folder
   * header, a group row): seeded on MOUNT rather than at setup, so the first paint is
   * the same expanded one the server drew, and written through on toggle. The folder
   * and the nested group each carried this ref-plus-onMounted-plus-toggle by hand.
   */
  function useFor(id: () => string | number): { collapsed: Ref<boolean>; toggle: () => void } {
    const collapsed = ref(false);
    onMounted(() => {
      collapsed.value = isCollapsed(id());
    });
    return {
      collapsed,
      toggle() {
        collapsed.value = !collapsed.value;
        set(id(), collapsed.value);
      },
    };
  }

  return { isCollapsed, set, useFor };
}
