// A trip's distance is typed whether or not the list has a trail link.
//
// It used to live only in the panel that edits a link, and it was cleared with the link,
// so a list with no route page to point at had no way to say how far the trip went.
// Now the Add a trail panel takes it too, a distance with no link reads in the row where
// "Add a trail" was (as a set date reads where "Add dates" was), and removing a link
// leaves it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import ListHead from "~/components/ListHead.vue";
import type { ListSnapshot } from "~~/shared/types";
import { CLEARS_WITH_LINK } from "~~/shared/trailLink";
import { snapshotFor } from "./helpers/list";

const setMeta = vi.fn();
mockNuxtImport("useGearList", () => () => ({ setMeta }));

const snap = (over: Partial<ListSnapshot> = {}): ListSnapshot => ({
  ...snapshotFor({ shareCode: "SNAPCODE0001", slug: "test-list-aaa111", title: "Timberline" }),
  ...over,
});

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  setMeta.mockClear();
});

describe("a trip distance without a trail link", () => {
  it("can be typed in the Add a trail panel", async () => {
    wrapper = mount(ListHead, { props: { snapshot: snap() }, attachTo: document.body });
    await wrapper.find("button.head__add").trigger("click");
    await nextTick();
    const field = wrapper.find<HTMLInputElement>("input.head__distinput");
    expect(field.exists()).toBe(true);
    field.element.value = "12 km";
    await field.trigger("change");
    expect(setMeta).toHaveBeenCalledWith({ trailDistanceM: 12_000 });
  });

  it("reads in the row where Add a trail was, and still opens the panel", async () => {
    wrapper = mount(ListHead, { props: { snapshot: snap({ trailDistanceM: 12_000, trailDistanceUnit: "km" }) } });
    const row = wrapper.find("button.head__add");
    expect(row.text()).toContain("12 km");
    expect(row.text()).not.toContain("Add a trail");
    await row.trigger("click");
    await nextTick();
    expect(wrapper.find<HTMLInputElement>("input.head__distinput").element.value).toBe("12");
  });

  it("is kept when the link is removed", async () => {
    wrapper = mount(ListHead, {
      props: { snapshot: snap({ trailUrl: "https://example.com/trail/rae-lakes", trailDistanceM: 66_000 }) },
    });
    await wrapper.find("button.head__cardedit").trigger("click");
    await nextTick();
    await wrapper.find("button.head__panelremove").trigger("click");
    const patch = setMeta.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(patch.trailUrl).toBe("");
    expect(patch).not.toHaveProperty("trailDistanceM");
    expect(CLEARS_WITH_LINK).not.toHaveProperty("trailDistanceM");
  });
});
