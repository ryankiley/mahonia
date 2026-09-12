// @vitest-environment nuxt
//
// A press inside the trail panel must not close the trail panel.
//
// The panel closes when focus leaves it — that is how tabbing past its last control
// puts the row back to rest. But a mouse press moves focus too, and on a node that
// can't take focus itself (the "Import map file" label, the lede, a strip of padding)
// every engine hands it to the nearest ancestor that CAN. In the editor that ancestor
// was <main tabindex="-1">, the skip link's target, which is outside the panel: the
// panel read the press as a departure and closed on the mousedown, so the mouseup
// landed on the page underneath and the click never reached the label. The file
// picker never opened, and nothing on screen said why.
//
// The fix makes the panel itself focusable, so the press stops there. These cases
// drive the press the way the browser does — the walk up to the first focusable
// ancestor, then focus() — rather than dispatching a focusout with a hand-picked
// relatedTarget, because the walk is the whole bug: a hand-picked target would pass
// against the broken panel too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import ListHead from "~/components/ListHead.vue";
import type { ListSnapshot } from "~~/shared/types";

const setMeta = vi.fn();
mockNuxtImport("useGearList", () => () => ({ setMeta }));

const snap = (): ListSnapshot => ({
  shareCode: "SNAPCODE0001",
  slug: "test-list-aaa111",
  title: "Timberline",
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version: 1,
  isPublic: false,
});

/**
 * What a mouse press does to focus, in every engine: the pressed node takes it if it
 * can, else the nearest ancestor that can, else whatever had it lets go. The selector
 * is the click-focusable set — form controls, links, anything with a tabindex, which
 * includes tabindex="-1" (mouse-focusable, just not in the Tab order).
 */
function press(node: Element) {
  const target = node.closest<HTMLElement>("input, textarea, select, button, a[href], [tabindex]");
  if (target) target.focus();
  else (document.activeElement as HTMLElement | null)?.blur();
}

// The editor's shell around the component: <main id="main-content" tabindex="-1"> is
// what GearEditor renders, and the button after it is the next Tab stop out of the
// panel — the thing a keyboard departure lands on.
let main: HTMLElement;
let after: HTMLButtonElement;
let wrapper: VueWrapper;

beforeEach(async () => {
  main = document.createElement("main");
  main.id = "main-content";
  main.tabIndex = -1;
  document.body.appendChild(main);
  const mountPoint = document.createElement("div");
  main.appendChild(mountPoint);
  after = document.createElement("button");
  after.textContent = "next stop";
  main.appendChild(after);
  wrapper = mount(ListHead, { props: { snapshot: snap() }, attachTo: mountPoint });
  // "Add a trail" opens the panel and puts the caret in the Link field — the state
  // every press in these cases starts from
  await wrapper.find("button.head__add").trigger("click");
  await nextTick();
  expect(wrapper.find(".head__panel").exists()).toBe(true);
  expect(document.activeElement).toBe(wrapper.find("input[type=url]").element);
});

afterEach(() => {
  wrapper.unmount();
  main.remove();
  setMeta.mockClear();
});

describe("the trail panel under a mouse press", () => {
  // The report: "Import map file" did nothing. The press closed the panel before the
  // click could open the picker.
  it("stays open when the map-file label is pressed, and the click reaches the file input", async () => {
    const label = wrapper.find("label.head__gpxbtn");
    const picker = vi.fn();
    label.find("input[type=file]").element.addEventListener("click", (e) => {
      picker();
      e.preventDefault(); // the chooser itself is the browser's; only the activation is ours
    });

    press(label.element);
    await nextTick();
    expect(wrapper.find(".head__panel").exists()).toBe(true);

    // the mouseup that follows lands on the same label, so the click fires — and the
    // label hands it to its input, which is what opens the chooser
    await label.trigger("click");
    expect(picker).toHaveBeenCalledTimes(1);
  });

  // The same walk from anything else in the panel that isn't a control: the lede is
  // the widest such target and the easiest to land a stray press on.
  it("stays open when its own text is pressed", async () => {
    press(wrapper.find(".head__panellede").element);
    await nextTick();
    expect(wrapper.find(".head__panel").exists()).toBe(true);
    // focus went to the panel, not past it to the editor's <main>
    expect(wrapper.find(".head__panel").element.contains(document.activeElement)).toBe(true);
  });

  // Held: the keyboard path is what the focusout closer exists for. Focus actually
  // leaving — for a control beyond the panel — still puts the row to rest.
  it("still closes when focus moves to a control outside it", async () => {
    after.focus();
    await nextTick();
    expect(wrapper.find(".head__panel").exists()).toBe(false);
  });
});
