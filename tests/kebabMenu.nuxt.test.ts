// The ⋯ shell's `open` event, under a parent that BINDS the model. With the model
// bound, defineModel's getter returns the prop, which has not re-rendered by the line
// after the write, so a toggle that read open.value back announced the menu on close.
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import KebabMenu from "~/components/KebabMenu.vue";

enableAutoUnmount(afterEach);

describe("KebabMenu", () => {
  it("announces the opening, once, and never the closing, when a parent holds its state", async () => {
    const onOpen = vi.fn();
    const Parent = defineComponent(() => {
      const open = ref(false);
      return () => h(KebabMenu, { open: open.value, "onUpdate:open": (v: boolean) => (open.value = v), onOpen });
    });
    const w = mount(Parent, { attachTo: document.body });
    const trigger = w.get('[aria-label="More actions"]');

    await trigger.trigger("click");
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(onOpen).toHaveBeenCalledTimes(1);

    await trigger.trigger("click");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
