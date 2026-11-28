// The trail panel's Link field, and what it does with a value that isn't a link.
//
// It used to hand whatever was typed to the reducer, which stores only an http(s) URL
// and ignores the rest: the panel closed, the text went with it, and the row still said
// "Add a trail". A pasted "alltrails.com/trail/…" went the same way, for want of a
// scheme. Now a bare web address is committed as https, and anything that still isn't a
// link stays in the box with a line under it, through the gesture that committed it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import ListHead from "~/components/ListHead.vue";
import { CLEARS_WITH_LINK } from "~~/shared/trailLink";
import type { ListSnapshot } from "~~/shared/types";
import { headSnapshot } from "./helpers/listHead";

const setMeta = vi.fn();
mockNuxtImport("useGearList", () => () => ({ setMeta }));

let wrapper: VueWrapper;
const panel = () => wrapper.find(".head__panel");
const field = () => wrapper.get<HTMLInputElement>("input[type=url]");
const line = () => wrapper.find(".head__gpxerr[role=alert]");

async function open(over: Partial<ListSnapshot> = {}) {
  wrapper = mount(ListHead, { props: { snapshot: headSnapshot(over) }, attachTo: document.body });
  if (over.trailUrl) {
    await wrapper.get("button.head__link").trigger("click");
    await wrapper.findAll(".head__card button").find((b) => b.text() === "Edit")!.trigger("click");
  } else await wrapper.get("button.head__add").trigger("click");
  await nextTick();
  expect(panel().exists()).toBe(true);
}

/** Type into the Link field: the value, and the input event a keystroke fires. */
async function type(value: string) {
  field().element.value = value;
  await field().trigger("input");
}

/** A typed edit commits on blur. No test DOM fires that change itself, so the blur does. */
function commitOnBlur() {
  const el = field().element;
  el.addEventListener("blur", () => el.dispatchEvent(new Event("change", { bubbles: true })), { once: true });
}

/** A click on the page past the row, with the press that blurs the field first. */
async function clickAway() {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  field().element.blur();
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
  await nextTick();
}

beforeEach(() => setMeta.mockClear());
afterEach(() => {
  wrapper.unmount();
  document.body.innerHTML = "";
});

describe("the Link field", () => {
  it("commits a bare web address as https", async () => {
    await open();
    await type("alltrails.com/trail/us/california/rae-lakes-loop");
    await field().trigger("change");
    expect(setMeta).toHaveBeenCalledWith({ trailUrl: "https://alltrails.com/trail/us/california/rae-lakes-loop" });
    expect(line().exists()).toBe(false);
  });

  it("keeps a value that isn't a link, says so, and sends nothing", async () => {
    await open();
    await type("rae lakes loop");
    await field().trigger("change");
    expect(setMeta).not.toHaveBeenCalled();
    expect(line().text()).toBe("That isn’t a link.");
    // the line's arrival re-renders the panel, which is what used to empty the box
    expect(field().element.value).toBe("rae lakes loop");
    expect(field().attributes("aria-invalid")).toBe("true");
    expect(field().attributes("aria-describedby")).toBe(line().attributes("id"));
  });

  it("drops the line as soon as the field is edited", async () => {
    await open();
    await type("rae lakes loop");
    await field().trigger("change");
    await type("rae lakes loo");
    expect(line().exists()).toBe(false);
    expect(field().element.value).toBe("rae lakes loo");
    expect(field().attributes("aria-invalid")).toBeUndefined();
  });

  it("stays open on the Enter that committed a refused link, with the caret back in the field", async () => {
    await open();
    await type("rae lakes loop");
    commitOnBlur();
    await field().trigger("keydown", { key: "Enter" });
    expect(panel().exists()).toBe(true);
    expect(line().exists()).toBe(true);
    expect(document.activeElement).toBe(field().element);
    // and is not a trap: Escape closes it, and the refused text does not come back
    await field().trigger("keydown", { key: "Escape" });
    expect(panel().exists()).toBe(false);
    await wrapper.get("button.head__add").trigger("click");
    await nextTick();
    expect(field().element.value).toBe("");
    expect(line().exists()).toBe(false);
  });

  it("stays open through the click away that committed a refused link, and closes on the next", async () => {
    await open();
    await type("rae lakes loop");
    commitOnBlur();
    await clickAway();
    expect(panel().exists()).toBe(true);
    expect(line().exists()).toBe(true);
    await clickAway();
    expect(panel().exists()).toBe(false);
  });

  it("still closes on Enter when the link is good", async () => {
    await open();
    await type("https://example.com/timberline");
    commitOnBlur();
    await field().trigger("keydown", { key: "Enter" });
    expect(setMeta).toHaveBeenCalledWith({ trailUrl: "https://example.com/timberline" });
    expect(panel().exists()).toBe(false);
  });

  it("still removes the trail when the field is emptied", async () => {
    await open({ trailUrl: "https://example.com/timberline" });
    await type("");
    await field().trigger("change");
    // one write, the same one Remove link makes
    expect(setMeta.mock.calls).toEqual([[{ trailUrl: "", ...CLEARS_WITH_LINK }]]);
    expect(line().exists()).toBe(false);
  });

  it("leaves the stored link alone when its replacement is refused", async () => {
    await open({ trailUrl: "https://example.com/timberline" });
    await type("javascript:alert(1)");
    await field().trigger("change");
    expect(setMeta).not.toHaveBeenCalled();
    expect(line().exists()).toBe(true);
  });
});
