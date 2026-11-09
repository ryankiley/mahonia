// The editor's ⋯ menu, now its own Lazy component (EditorMenu) with the rows as a
// table and every action an emit. The twin of tests/readonlyMenu.nuxt.test.ts, for
// the same reason: what a table-plus-emits menu gets wrong, it gets wrong silently.
//   · every row's event has to be in the compiled `emits` list, or the parent's
//     `@forget` listener falls through as a DOM attribute on the <ul> and the row does
//     nothing. The list is built from a type-alias union (call-signature defineEmits);
//     switching to the object form would drop the union and pass typecheck.
//   · three states hide rows — the first-run screen (Duplicate), an unsaved
//     draft (the whole destructive foot), a claimed open (Forget) — and each is a prop
//     the parent computes, so a dropped `hidden` or `v-if` shows a row that acts on
//     nothing.
//   · close comes BEFORE the row's event, so a dialog the event opens never sits under
//     a menu that is still there.
//   · the site foot (#376) holds two rows that emit and two that navigate; the links
//     close the menu too.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import EditorMenu from "~/components/EditorMenu.vue";

enableAutoUnmount(afterEach);

const rows = (w: ReturnType<typeof mount>) => w.findAll('[role="menuitem"]').map((b) => b.text().trim());

function openMenu(props: Partial<InstanceType<typeof EditorMenu>["$props"]> = {}) {
  return mount(EditorMenu, {
    props: {
      open: true,
      firstRun: false,
      saved: true,
      openedByCode: false,
      ...props,
    },
    attachTo: document.body,
    global: { stubs: { NuxtLink: { template: "<a><slot /></a>" } } },
  });
}

describe("the editor's ⋯ menu", () => {
  it("declares every row's event, so no listener falls through as an attribute", () => {
    const emits = (EditorMenu as unknown as { emits: string[] }).emits;
    expect([...emits].sort()).toEqual(
      ["close", "delete", "duplicate", "feedback", "forget", "import", "people", "shortcuts"].sort(),
    );
  });

  it("reads: list rows, the site foot, then the destructive foot", () => {
    const w = openMenu();
    expect(rows(w)).toEqual([
      "Add people",
      "Duplicate this list",
      "Import a list…",
      "Keyboard shortcuts",
      "Send feedback…",
      "Help",
      "About",
      "Legal",
      "Forget this list",
      "Delete this list",
    ]);
    // Export lives in the sharing panel now (SharePanel's Export tab)
    expect(w.find(".menu__secthead").exists()).toBe(false);
    // #376's scroller, so a short phone can still reach the foot
    expect(w.get(".menu__list").classes()).toContain("editor__actions");
  });

  it("stands Duplicate down on the first-run screen", () => {
    const w = openMenu({ firstRun: true, saved: false });
    expect(rows(w)).not.toContain("Duplicate this list");
  });

  it("offers the destructive foot only for a saved list, and Forget only for its own device", () => {
    const draft = openMenu({ saved: false });
    expect(rows(draft)).not.toContain("Delete this list");
    expect(rows(draft)).not.toContain("Forget this list");
    draft.unmount();

    const claimed = openMenu({ openedByCode: true });
    expect(rows(claimed)).toContain("Delete this list");
    expect(rows(claimed)).not.toContain("Forget this list");
  });

  it("emits close before the row's own event", async () => {
    const w = openMenu();
    await w.findAll('[role="menuitem"]').find((b) => b.text().includes("Forget"))!.trigger("click");
    const log = w.emitted();
    expect(log.close).toHaveLength(1);
    expect(log.forget).toHaveLength(1);
    // emitted() is insertion-ordered (the native click the wrapper records comes
    // after both), so the first key is the first event fired
    expect(Object.keys(log).slice(0, 2)).toEqual(["close", "forget"]);
  });

  it("closes on the site links too", async () => {
    const w = openMenu();
    await w.findAll('[role="menuitem"]').find((b) => b.text() === "About")!.trigger("click");
    expect(w.emitted().close).toHaveLength(1);
  });
});
