// useMenuPlate's two decisions about the KEYBOARD — the travelling wash's own geometry is
// layout and can't be checked here (happy-dom lays nothing out), but these are about
// which classes and attributes land where, which it can.
//
//   · A focus move PLACES the plate rather than letting it travel: Tab and the arrows
//     come in bursts, and keyboard actions get no animation at all.
//     The pointer is what the plate travels for.
//   · The row the plate stands on is marked [data-plated], so its own :focus-visible
//     wash stands down under the plate (controls.scss) — and only that row, only while
//     the plate is on it, so a focused row the plate has left still shows where focus is.
//
// Needs the Nuxt environment because the composable leans on auto-imports (ref, watch)
// and is meant to run inside a component's setup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { useMenuPlate } from "~/composables/useMenuPlate";

enableAutoUnmount(afterEach);
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// A menu the way every consumer builds one: the plate as the list's first child, rows
// marked [data-row], the `on` handlers on the list.
const Menu = defineComponent({
  setup() {
    const { plateRef, listRef, on } = useMenuPlate();
    return () =>
      h("ul", { ref: listRef, class: "menu__list", onPointerover: on.pointerover, onPointerleave: on.pointerleave, onFocusin: on.focusin, onFocusout: on.focusout }, [
        h("span", { ref: plateRef, class: "menu__plate" }),
        ...["one", "two", "three"].map((k) => h("li", { key: k }, [h("button", { type: "button", class: "menu__item", "data-row": "", id: k }, k)])),
      ]);
  },
});

async function mountMenu() {
  const w = mount(Menu, { attachTo: document.body });
  await flushPromises();
  const plate = w.find(".menu__plate").element as HTMLElement;
  const row = (id: string) => w.find(`#${id}`).element as HTMLElement;
  // every class the plate is handed, in order — `is-placing` comes off again in the same
  // handler, so the record is the only place it can be seen
  const added: string[] = [];
  const add = plate.classList.add.bind(plate.classList);
  vi.spyOn(plate.classList, "add").mockImplementation((...c: string[]) => {
    added.push(...c);
    add(...c);
  });
  return { w, plate, row, added };
}

describe("the menu plate and the keyboard", () => {
  it("places, never travels, when focus moves it", async () => {
    const { plate, row, added } = await mountMenu();
    row("one").focus();
    row("two").focus(); // the plate is already on: a pointer move here would travel
    expect(added.filter((c) => c === "is-placing")).toHaveLength(2);
    expect(plate.classList.contains("is-placing")).toBe(false); // and it comes off again
    expect(plate.classList.contains("is-on")).toBe(true);
  });

  it("travels for the pointer once it is on", async () => {
    const { row, added } = await mountMenu();
    row("one").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    row("two").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    // the first landing is placed (nothing to travel from); the second is a travel
    expect(added.filter((c) => c === "is-placing")).toHaveLength(1);
  });

  it("marks only the row it stands on, and lets go when it leaves", async () => {
    const { w, row } = await mountMenu();
    row("one").focus();
    expect(row("one").hasAttribute("data-plated")).toBe(true);

    // the pointer takes the plate elsewhere: the focused row must get its own mark back
    row("three").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(row("one").hasAttribute("data-plated")).toBe(false);
    expect(row("three").hasAttribute("data-plated")).toBe(true);

    // ...and out of the card altogether: nothing is plated
    await w.find("ul").trigger("pointerleave");
    expect(w.findAll("[data-plated]")).toHaveLength(0);
  });
});
