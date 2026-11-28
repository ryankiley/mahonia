// What is typed into the list header and not yet committed, when the list changes or
// the panel is put away under it.
//
// The title has its own suite (listTitleDraft), from the report that started this: the
// controller replaces the snapshot under a person in two places it cannot hold off, and
// a field bound straight to the snapshot is rewritten by that. Two of the trail panel's
// fields were still bound that way: a half-typed Link title went back to the stored
// one, and a half-typed Distance to empty. All four hold a draft the same way now.
//
// And a panel that closes on a touch drag past it (as every menu does on a phone) has
// to commit first: its fields commit on blur, and a scroll blurs nothing.
//
// TYPING IS `input`, NOT setValue, which fires the commit as well (see listTitleDraft).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import ListHead from "~/components/ListHead.vue";
import type { ListSnapshot } from "~~/shared/types";
import { headSnapshot } from "./helpers/listHead";

const setMeta = vi.fn();
mockNuxtImport("useGearList", () => () => ({ setMeta }));

const snap = (over: Partial<ListSnapshot> = {}): ListSnapshot =>
  headSnapshot({ trailUrl: "https://example.com/timberline", trailLabel: "Old name", ...over });

const FIELDS = {
  "List name": "textarea.head__title",
  Link: 'input[id$="-url"]',
  "Link title": 'input[id$="-title"]',
  Distance: 'input[id$="-dist"]',
};

let wrapper: VueWrapper;
const panel = () => wrapper.find(".head__panel");
const line = () => wrapper.find(".head__gpxerr[role=alert]");
const box = (name: keyof typeof FIELDS) => wrapper.get<HTMLInputElement>(FIELDS[name]);

/** Keystrokes, no commit. */
async function type(name: keyof typeof FIELDS, value: string) {
  box(name).element.focus();
  box(name).element.value = value;
  await box(name).trigger("input");
}

/** A finger dragging the page: a pointer goes down, then the moves a scroll is made of. */
async function drag({ moves = 1 } = {}) {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  for (let i = 0; i < moves; i++) document.body.dispatchEvent(new Event("touchmove", { bubbles: true }));
  await nextTick();
}

beforeEach(async () => {
  setMeta.mockClear();
  wrapper = mount(ListHead, { props: { snapshot: snap() }, attachTo: document.body });
  await wrapper.findAll(".head__card button").find((b) => b.text() === "Edit")!.trigger("click");
  await nextTick();
  expect(panel().exists()).toBe(true);
});

afterEach(() => {
  wrapper.unmount();
  document.body.innerHTML = "";
});

describe("typed and not yet committed, when the snapshot is replaced", () => {
  it.each([
    ["List name", "South Sister Summ"],
    ["Link", "https://example.com/new-half-typ"],
    ["Link title", "New name half-typ"],
    ["Distance", "41.5"],
  ] as const)("keeps a half-typed %s", async (name, typed) => {
    await type(name, typed);
    // load() adopting the server's copy over the local one it painted first
    await wrapper.setProps({ snapshot: snap({ version: 2 }) });
    expect(box(name).element.value).toBe(typed);
  });

  // the other half: a field nobody is typing in still has to follow the list
  it("still takes a new value in a field with nothing typed", async () => {
    await type("Distance", "41.5");
    await wrapper.setProps({ snapshot: snap({ version: 2, trailLabel: "Renamed elsewhere" }) });
    expect(box("Link title").element.value).toBe("Renamed elsewhere");
  });

  it("shows what was stored once the typed value commits", async () => {
    await type("Distance", "not a distance");
    await box("Distance").trigger("change");
    expect(setMeta).toHaveBeenCalledWith({ trailDistanceM: "" });
    expect(box("Distance").element.value).toBe("");
  });
});

describe("typed and not yet committed, when the panel is dismissed from outside", () => {
  it("is committed by a touch drag past the panel", async () => {
    await type("Link title", "Timberline Trail");
    await drag();
    expect(setMeta.mock.calls).toEqual([[{ trailLabel: "Timberline Trail" }]]);
    expect(panel().exists()).toBe(false);
  });

  // a press does blur the field, and a browser commits on that; the dismissal that
  // follows on the click must not send it a second time
  it("is committed once by a press past the panel", async () => {
    await type("Link title", "Timberline Trail");
    const el = box("Link title").element;
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    el.blur();
    el.dispatchEvent(new Event("change", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await nextTick();
    expect(setMeta.mock.calls).toEqual([[{ trailLabel: "Timberline Trail" }]]);
    expect(panel().exists()).toBe(false);
  });

  it("keeps the panel and says why when the drag's commit is a link that is refused", async () => {
    await type("Link", "rae lakes loop");
    await drag({ moves: 3 });
    expect(setMeta).not.toHaveBeenCalled();
    expect(panel().exists()).toBe(true);
    expect(line().text()).toBe("That isn’t a link.");
    expect(box("Link").element.value).toBe("rae lakes loop");
    // held through the gesture that committed it, and no longer: the next one closes
    await drag();
    expect(panel().exists()).toBe(false);
    expect(setMeta).not.toHaveBeenCalled();
  });
});
