// <AnimatedCount>'s motion contract — when the cascade runs, and when a change is
// written into the figure without one.
//
// The cascade (every character re-mounted and popped in, a stagger apart) plays on
// mount and on a change that arrives with nothing playing. It never starts over for a
// change off the keyboard or one inside a run still playing: each restart threw every
// character back to the keyframe's transparent first frame, so holding ↑ in a weight
// field, or pressing the ± stepper in a quick run, kept most of the total blank. That
// lives where a screenshot can't see it — in which DOM nodes survive a change (a kept
// node is a kept animation) and which ones are told to sit the run out — so it is
// asserted on the nodes. A nuxt test because the component leans on auto-imports and
// the modality plugin's helper.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";
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

// Past any run here: the pop's beat (570ms) and seven characters' stagger, with room.
const LANDED = 2_000;
// Well inside one.
const MID_RUN = 100;

type W = ReturnType<typeof mount>;
const nodes = (w: W) => w.findAll(".acount__ch").map((c) => c.element);
const text = (w: W) => nodes(w).map((n) => n.textContent).join("");
const late = (w: W) => w.findAll(".acount__ch").map((c) => c.classes("is-late"));
const animating = (w: W) => w.find(".acount").classes("is-animating");

async function change(w: W, value: string) {
  await w.setProps({ value });
  await nextTick(); // a run starts the tick after the re-key, past a forced reflow
}

describe("AnimatedCount", () => {
  it("cascades in on mount", async () => {
    const w = mount(AnimatedCount, { props: { value: "4,723 g" } });
    await nextTick(); // set in onMounted, so on the render after the first
    expect(nodes(w)).toHaveLength(7);
    expect(animating(w)).toBe(true);
    expect(late(w).some(Boolean)).toBe(false);
  });

  it("runs the cascade again for a change that arrives with nothing playing", async () => {
    const w = mount(AnimatedCount, { props: { value: "4,723 g" } });
    const before = nodes(w);
    clock += LANDED;
    await change(w, "4,724 g");
    expect(text(w)).toBe("4,724 g");
    // every character re-mounted: that is what restarts the pop on each
    expect(nodes(w).filter((n) => before.includes(n))).toEqual([]);
    expect(animating(w)).toBe(true);
    expect(late(w).some(Boolean)).toBe(false);
  });

  it("doesn't start over for a change while the run is still playing", async () => {
    const w = mount(AnimatedCount, { props: { value: "4,723 g" } });
    const before = nodes(w);
    clock += MID_RUN; // the ± stepper pressed again
    await change(w, "4,724 g");
    // the same nodes, so every character carries on from where its pop had got to
    expect(nodes(w)).toEqual(before);
    expect(text(w)).toBe("4,724 g");
    expect(w.find(".visually-hidden").text()).toBe("4,724 g");
  });

  it("doesn't start over for a change off the keyboard, however long since the last", async () => {
    const w = mount(AnimatedCount, { props: { value: "520 g" } });
    const before = nodes(w);
    clock += LANDED;
    document.documentElement.dataset.input = "keyboard";
    await change(w, "521 g");
    expect(nodes(w)).toEqual(before);
    expect(text(w)).toBe("521 g");
  });

  it("never leaves a character transparent: one that turns up mid-run sits the run out", async () => {
    const w = mount(AnimatedCount, { props: { value: "999 g" } });
    const before = nodes(w);
    clock += MID_RUN;
    await change(w, "1,000 g"); // two positions longer
    expect(nodes(w).slice(0, 5)).toEqual(before);
    // the two new nodes arrived after the run began: in place, not a stagger late
    expect(late(w)).toEqual([false, false, false, false, false, true, true]);
    // ...and a run that starts afresh takes every position again
    clock += LANDED;
    await change(w, "1,001 g");
    expect(late(w).some(Boolean)).toBe(false);
  });
});
