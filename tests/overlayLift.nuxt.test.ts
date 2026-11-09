// useOverlayLift (composables/dom.ts): the three rules a popover inside a clipping body
// keeps, so the body's open-popover count can't drift. The row's ⋯ menus kept only the
// first, so a last row's menu was cut at the folder's edge as it faded, and a row
// removed with its menu open left the count stuck.
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { useOverlayLift } from "~/composables/dom";

enableAutoUnmount(afterEach);

function mountLift() {
  const toggle = vi.fn();
  let api!: ReturnType<typeof useOverlayLift>;
  const w = mount(
    defineComponent({
      setup() {
        api = useOverlayLift(toggle);
        return () => h("div");
      },
    }),
  );
  return { w, toggle, api };
}

describe("useOverlayLift", () => {
  it("tells the body once per change, however often it's asked", () => {
    const { toggle, api } = mountLift();
    api.lift();
    api.lift();
    api.release();
    api.release();
    expect(toggle.mock.calls).toEqual([[true], [false]]);
  });

  it("lets go on unmount, so a removed row doesn't hold the clip open", () => {
    const { w, toggle, api } = mountLift();
    api.lift();
    w.unmount();
    expect(toggle.mock.calls).toEqual([[true], [false]]);
  });

  it("says nothing on unmount when it was never lifted", () => {
    const { w, toggle } = mountLift();
    w.unmount();
    expect(toggle).not.toHaveBeenCalled();
  });
});
