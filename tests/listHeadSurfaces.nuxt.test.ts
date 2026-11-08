// The surfaces that hang off the list's meta row: the trail panel, the link card and the
// dates picker. They overlap in the same space, so at most one may be up, and each way of
// closing one must leave the others alone. Driven through the page's own controls: the
// row holds which surface is up as one value, and these are the paths into and out of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import ListHead from "~/components/ListHead.vue";
import { snapshotFor } from "./helpers/list";

const setMeta = vi.fn();
mockNuxtImport("useGearList", () => () => ({ setMeta }));

let wrapper: VueWrapper;

const name = () => wrapper.get("button.head__link");
const datesButton = () => wrapper.get("button.head__datesbtn");
const panel = () => wrapper.find(".head__panel");
const card = () => wrapper.find(".head__card");
const dates = () => wrapper.find(".head__datespanel");
const pinned = () => card().exists() && card().classes("is-pinned");

/** A click somewhere, with the pointerdown onClickOutside reads its start from. */
async function clickOn(el: Element) {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
  await nextTick();
}

beforeEach(() => {
  wrapper = mount(ListHead, {
    props: {
      snapshot: {
        ...snapshotFor({ shareCode: "SNAPCODE0001", slug: "test-list-aaa111", title: "Timberline" }),
        trailUrl: "https://example.com/timberline",
      },
    },
    attachTo: document.body,
  });
});

afterEach(() => {
  wrapper.unmount();
  document.body.innerHTML = "";
});

describe("one surface at a time", () => {
  it("pins the card on a press of the name, and unpins it on the next", async () => {
    await name().trigger("click");
    expect(pinned()).toBe(true);
    expect(name().attributes("aria-expanded")).toBe("true");
    await name().trigger("click");
    expect(pinned()).toBe(false);
    expect(name().attributes("aria-expanded")).toBe("false");
  });

  it("replaces a pinned card with the calendar, and the calendar with the card", async () => {
    await name().trigger("click");
    await datesButton().trigger("click");
    expect(pinned()).toBe(false);
    expect(dates().exists()).toBe(true);

    await name().trigger("click");
    expect(pinned()).toBe(true);
    expect(dates().exists()).toBe(false);
  });

  it("replaces the calendar with the trail panel, and the panel with the calendar", async () => {
    await datesButton().trigger("click");
    await card().findAll("button").find((b) => b.text() === "Edit")!.trigger("click");
    await nextTick();
    expect(panel().exists()).toBe(true);
    expect(dates().exists()).toBe(false);

    await datesButton().trigger("click");
    expect(panel().exists()).toBe(false);
    expect(dates().exists()).toBe(true);
  });

  it("toggles the calendar from its own button", async () => {
    await datesButton().trigger("click");
    expect(dates().exists()).toBe(true);
    await datesButton().trigger("click");
    expect(dates().exists()).toBe(false);
  });
});

describe("closing one surface", () => {
  const openPanel = async () => {
    await card().findAll("button").find((b) => b.text() === "Edit")!.trigger("click");
    await nextTick();
    expect(panel().exists()).toBe(true);
  };

  it("closes the trail panel on Escape", async () => {
    await openPanel();
    await panel().trigger("keyup", { key: "Escape" });
    expect(panel().exists()).toBe(false);
  });

  // the commit itself is the field's change, which fires on the blur only for an edit a
  // person typed; that half is checked in a real browser, not here
  it("closes the trail panel on Enter in a field", async () => {
    await openPanel();
    await wrapper.get("input[type=url]").trigger("keydown", { key: "Enter" });
    expect(panel().exists()).toBe(false);
  });

  // a keyboard opens the panel on Enter's keydown, and the same key's keyup then lands
  // in the field the panel focused: that keyup is not a request to close it again
  it("stays open when the Enter that opened it is released in its field", async () => {
    await openPanel();
    await wrapper.get("input[type=url]").trigger("keyup", { key: "Enter" });
    expect(panel().exists()).toBe(true);
  });

  it("leaves the calendar up on a click inside it, and closes it on one past the row", async () => {
    await datesButton().trigger("click");
    await clickOn(dates().element);
    expect(dates().exists()).toBe(true);
    await clickOn(document.body);
    expect(dates().exists()).toBe(false);
  });

  it("closes a pinned card on a click past the row, and leaves it up on one inside", async () => {
    await name().trigger("click");
    await clickOn(card().element);
    expect(pinned()).toBe(true);
    await clickOn(document.body);
    expect(pinned()).toBe(false);
  });
});
