// Escape inside a menu closes the menu and nothing around it. useMenuDismiss takes the
// key on the way down and marks it handled; onKeyStroke (composables/dom.ts), which a
// dialog and the gear pane close on, skips a handled key. The gear pane once listened
// without that check, so Escape in its "Add to" menu closed the whole pane.
//
// Driven through OptionMenu, the smallest real menu, with a bare onKeyStroke standing in
// for the surface around it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { effectScope } from "vue";
import OptionMenu from "~/components/OptionMenu.vue";
import { onKeyStroke } from "~/composables/dom";

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
