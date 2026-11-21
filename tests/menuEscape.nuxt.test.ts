// Escape inside a menu closes the menu and nothing around it. useMenuDismiss takes the
// key on the way down and marks it handled; onKeyStroke (composables/dom.ts), which a
// dialog and the gear pane close on, skips a handled key. The gear pane once listened
// without that check, so Escape in its "Add to" menu closed the whole pane.
//
// Driven through OptionMenu, the smallest real menu, with a bare onKeyStroke standing in
// for the surface around it.
//
// A row's popovers (its ⋯, carrier and nesting menus, the worn and calorie cards) share
// one open id and one set of listeners (useItemMenu) rather than a useMenuDismiss each,
// and that set once closed on Escape without marking the key handled: with My Gear open
// beside the list, Escape in a row's menu closed the pane too. Driven through
// ItemRowMenu, the row's menu shell.
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { effectScope } from "vue";
import ItemRowMenu from "~/components/ItemRowMenu.vue";
import OptionMenu from "~/components/OptionMenu.vue";
import { onKeyStroke } from "~/composables/dom";
import { useItemMenu } from "~/composables/useItemMenu";

let wrapper: ReturnType<typeof mount> | undefined;
enableAutoUnmount(afterEach);

function mountMenu() {
  wrapper = mount(OptionMenu, {
    props: {
      options: [
        { key: "a", label: "Shelter" },
        { key: "b", label: "Kitchen" },
      ],
      current: "a",
      label: "Folder to add into",
    },
    slots: { trigger: "<span>Shelter</span>" },
    attachTo: document.body,
  });
}

const isOpen = () => wrapper!.find(".menu__list").exists();
const escape = async () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  await flushPromises();
};

describe("Escape in a menu", () => {
  it("closes the menu only, then the surface on the next press", async () => {
    const closeSurface = vi.fn();
    const scope = effectScope();
    scope.run(() => onKeyStroke("Escape", closeSurface));
    mountMenu();
    await wrapper!.find(".optmenu__btn").trigger("click");
    expect(isOpen()).toBe(true);

    await escape();
    expect(isOpen()).toBe(false);
    expect(closeSurface).not.toHaveBeenCalled();

    await escape();
    expect(closeSurface).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});

describe("Escape in a row's popover", () => {
  afterEach(() => useItemMenu().close());

  function mountRowMenu() {
    wrapper = mount(ItemRowMenu, {
      props: { rowId: "row-1", kind: "menu", label: "More actions" },
      slots: { default: '<li><button type="button" role="menuitem" class="menu__item">Duplicate</button></li>' },
      attachTo: document.body,
    });
  }

  it("closes the popover only, then the surface on the next press", async () => {
    const closeSurface = vi.fn();
    const scope = effectScope();
    scope.run(() => onKeyStroke("Escape", closeSurface));
    mountRowMenu();
    await wrapper!.find("button[aria-haspopup]").trigger("click");
    await flushPromises();
    expect(isOpen()).toBe(true);

    await escape();
    expect(isOpen()).toBe(false);
    expect(closeSurface).not.toHaveBeenCalled();

    await escape();
    expect(closeSurface).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it("puts focus back on the trigger when it was inside the popover", async () => {
    mountRowMenu();
    const trigger = wrapper!.find("button[aria-haspopup]");
    await trigger.trigger("click");
    await flushPromises();
    (wrapper!.find(".menu__item").element as HTMLElement).focus();

    await escape();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
  });

  // the same listeners close it on a press outside, which is the other half of what
  // moved when the row's popovers took useMenuDismiss
  it("still closes on a click outside it, and stays open on one inside", async () => {
    mountRowMenu();
    await wrapper!.find("button[aria-haspopup]").trigger("click");
    await flushPromises();
    expect(isOpen()).toBe(true);

    await wrapper!.find(".menu__item").trigger("click");
    expect(isOpen()).toBe(true);

    document.body.click();
    await flushPromises();
    expect(isOpen()).toBe(false);
  });
});
