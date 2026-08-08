// @vitest-environment nuxt
//
// onScrollOutside (composables/dom.ts) — the mobile dismissal every anchored menu wires
// up beside onClickOutside. A menu hangs off a trigger that is usually STICKY, so
// scrolling neither carries it away nor takes it down; on a phone that leaves a card
// parked over the content you were trying to read, dismissable only by finding dead
// space and tapping it.
//
// Driven through OptionMenu because it is the smallest real consumer — a trigger, a
// popover and nothing else — so what's under test is the dismissal rather than a
// component's own state. happy-dom lays nothing out, but this behaviour is about event
// PATHS (did the drag start inside the card?) rather than geometry, so nothing needs
// faking: the listener's whole decision is one composedPath() check.
import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import OptionMenu from "~/components/OptionMenu.vue";

let wrapper: ReturnType<typeof mount> | undefined;

function mountMenu() {
  wrapper = mount(OptionMenu, {
    props: {
      options: [
        { key: "g", label: "Grams" },
        { key: "oz", label: "Ounces" },
      ],
      current: "g",
      label: "Weight unit",
    },
    slots: { trigger: "<span>g</span>" },
    attachTo: document.body,
  });
  return wrapper;
}

const open = () => wrapper!.find(".optmenu__btn").trigger("click");
const isOpen = () => wrapper!.find(".menu__list").exists();
// touchmove is the gesture itself — see onScrollOutside for why it watches that and not
// `scroll`, which fires for keyboard-avoidance scrolls nobody performed
const drag = async (target: Element | Window) => {
  target.dispatchEvent(new Event("touchmove", { bubbles: true, cancelable: false }));
  await flushPromises();
};

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
});

describe("menus dismiss on a touch scroll", () => {
  it("closes when the drag starts outside the menu", async () => {
    mountMenu();
    await open();
    expect(isOpen()).toBe(true);

    await drag(document.body);
    expect(isOpen()).toBe(false);
  });

  it("stays open when the drag is scrolling the menu's own content", async () => {
    mountMenu();
    await open();

    // the lists switcher caps its rows at 15rem and scrolls them — dragging THAT is the
    // opposite of leaving, so the path check has to hold the card open
    await drag(wrapper!.find(".menu__list").element);
    expect(isOpen()).toBe(true);
  });

  it("is not listening while the menu is closed", async () => {
    mountMenu();
    expect(isOpen()).toBe(false);

    // a drag with nothing open must not leave anything armed for the next open
    await drag(document.body);
    await open();
    expect(isOpen()).toBe(true);
  });
});
