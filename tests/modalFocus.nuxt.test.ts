// Where focus goes when a dialog closes. BaseModal puts it back on whatever held it
// when the dialog opened, and for a dialog opened from a menu row that was the row:
// the menu closed on the same press, the row was gone, and focus fell to <body>
// (Keyboard shortcuts, People, Import and Feedback from the editor's ⋯, and the same in
// the read view's and My Gear's menus). It goes to the menu's trigger now.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import BaseModal from "~/components/BaseModal.vue";
import KebabMenu from "~/components/KebabMenu.vue";

enableAutoUnmount(afterEach);

// A page with a ⋯ menu whose row opens a dialog, a plain button that opens the same
// dialog, and a second dialog the first one's action can open.
const Page = defineComponent({
  components: { BaseModal, KebabMenu },
  props: {
    /** the dialog's chunk arrives after the menu has closed (a Lazy dialog's first open) */
    late: Boolean,
    /** the parent mounts the dialog open with v-if and never tells it it closed (People) */
    mountedOpen: Boolean,
  },
  setup(props) {
    const open = ref(false);
    const here = ref(!props.late);
    const second = ref(false);
    function openDialog() {
      open.value = true;
      if (props.late) setTimeout(() => (here.value = true));
    }
    return { open, here, second, openDialog };
  },
  template: `
    <div>
      <button id="plain" type="button" @click="openDialog">Open</button>
      <KebabMenu>
        <template #default="{ close }">
          <li role="none">
            <button id="row" type="button" role="menuitem" class="menu__item" @click="close(); openDialog()">Open…</button>
          </li>
        </template>
      </KebabMenu>
      <template v-if="here">
        <BaseModal v-if="mountedOpen ? open : true" :open="mountedOpen ? true : open" label="First" @close="open = false">
          <button id="done" type="button" @click="open = false">Done</button>
          <button id="next" type="button" @click="second = true">Next</button>
        </BaseModal>
      </template>
      <BaseModal :open="second" label="Second" @close="second = false">
        <button id="inner" type="button" @click="open = false">Close the first</button>
      </BaseModal>
    </div>`,
});

const settle = async () => {
  await flushPromises();
  await new Promise((r) => setTimeout(r));
  await flushPromises();
  await nextTick();
};

/** Press a control the way a browser does: it takes focus, then it is clicked. */
async function press(w: ReturnType<typeof mount>, selector: string) {
  const el = w.get<HTMLElement>(selector);
  el.element.focus();
  await el.trigger("click");
  await settle();
}

const page = (props: { late?: boolean; mountedOpen?: boolean } = {}) => mount(Page, { props, attachTo: document.body });
const trigger = (w: ReturnType<typeof mount>) => w.get<HTMLElement>(".menu__btn").element;

describe("focus after a dialog closes", () => {
  it("returns to the button that opened it", async () => {
    const w = page();
    await press(w, "#plain");
    expect(w.get('[aria-label="First"]').element.contains(document.activeElement)).toBe(true);
    await press(w, "#done");
    expect(document.activeElement).toBe(w.get("#plain").element);
  });

  it("returns to the ⋯ when a menu row opened it", async () => {
    const w = page();
    await press(w, ".menu__btn");
    await press(w, "#row");
    expect(w.find("#row").exists()).toBe(false);
    await press(w, "#done");
    expect(document.activeElement).toBe(trigger(w));
  });

  it("returns to the ⋯ when the dialog only arrived after the menu had gone", async () => {
    const w = page({ late: true });
    await press(w, ".menu__btn");
    await press(w, "#row");
    await press(w, "#done");
    expect(document.activeElement).toBe(trigger(w));
  });

  it("returns to the ⋯ when the dialog is unmounted rather than closed", async () => {
    const w = page({ mountedOpen: true });
    await press(w, ".menu__btn");
    await press(w, "#row");
    await press(w, "#done");
    expect(w.find('[aria-label="First"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger(w));
  });

  it("leaves focus in a second dialog that is still open when the first closes", async () => {
    const w = page();
    await press(w, ".menu__btn");
    await press(w, "#row");
    await press(w, "#next");
    await press(w, "#inner");
    expect(w.find("#done").exists()).toBe(false);
    expect(w.get('[aria-label="Second"]').element.contains(document.activeElement)).toBe(true);
  });
});

describe("a menu row that closes its menu", () => {
  it("hands focus back to the trigger", async () => {
    const w = page({ late: true });
    await press(w, ".menu__btn");
    w.get<HTMLElement>("#row").element.focus();
    await w.get("#row").trigger("click");
    await nextTick();
    expect(document.activeElement).toBe(trigger(w));
  });
});
