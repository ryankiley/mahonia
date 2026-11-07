// <AnimatedCount>'s motion contract — which characters drop in, and when none do.
//
// It is a figure people read (the list's total, a group's weight), so it animates only
// to show a change, and only the characters that changed. That lives in two places a
// screenshot can't see: the KEYING (an unchanged character must stay the same DOM node,
// or its finished animation restarts the moment anything else changes) and the GATE
// (nothing on mount, nothing off the keyboard, nothing in a rapid run). A nuxt test
// because the component leans on auto-imports and the modality plugin's helper.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import AnimatedCount from "~/components/AnimatedCount.vue";

enableAutoUnmount(afterEach);

let clock = 1_000;
beforeEach(() => {
  clock = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  delete document.documentElement.dataset.input;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.input;
});

const chars = (w: ReturnType<typeof mount>) => w.findAll(".acount__ch").map((c) => c.element);
const fresh = (w: ReturnType<typeof mount>) => w.findAll(".acount__ch.is-new").map((c) => c.text());

describe("AnimatedCount", () => {
  it("animates nothing on mount", () => {
    const w = mount(AnimatedCount, { props: { value: "4,723 g" } });
    expect(w.findAll(".acount__ch")).toHaveLength(7);
    expect(fresh(w)).toEqual([]);
  });

  it("keeps every unchanged character's node and drops in only the changed one", async () => {
    const w = mount(AnimatedCount, { props: { value: "4,723 g" } });
    const before = chars(w);
    clock += 1_000;
    await w.setProps({ value: "4,724 g" });
    const after = chars(w);
    expect(after).toHaveLength(7);
    for (const i of [0, 1, 2, 3, 5, 6]) expect(after[i]).toBe(before[i]);
    expect(after[4]).not.toBe(before[4]);
    expect(fresh(w)).toEqual(["4"]);
  });

  it("takes the previous change's mark off once that character holds still", async () => {
    const w = mount(AnimatedCount, { props: { value: "4,723 g" } });
    clock += 1_000;
    await w.setProps({ value: "4,724 g" });
    clock += 1_000;
    await w.setProps({ value: "4,734 g" });
    // the 4 at position 4 kept its node and lost the class; only the 3 is new
    expect(fresh(w)).toEqual(["3"]);
  });

  it("drops nothing in when a change lands within the quiet window of the last", async () => {
    const w = mount(AnimatedCount, { props: { value: "1" } });
    clock += 1_000;
    await w.setProps({ value: "2" });
    expect(fresh(w)).toEqual(["2"]);
    clock += 100; // a stepper pressed again
    await w.setProps({ value: "3" });
    expect(fresh(w)).toEqual([]);
  });

  it("drops nothing in when the change came off the keyboard", async () => {
    const w = mount(AnimatedCount, { props: { value: "520 g" } });
    clock += 1_000;
    document.documentElement.dataset.input = "keyboard";
    await w.setProps({ value: "521 g" });
    expect(fresh(w)).toEqual([]);
    expect(w.find(".visually-hidden").text()).toBe("521 g");
  });
});
