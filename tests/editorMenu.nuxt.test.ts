// @vitest-environment nuxt
//
// The editor's ⋯ menu, now its own Lazy component (EditorMenu) with the rows as a
// table and every action an emit. The twin of tests/readonlyMenu.nuxt.test.ts, for
// the same reason: what a table-plus-emits menu gets wrong, it gets wrong silently.
//   · every row's event has to be in the compiled `emits` list, or the parent's
//     `@forget` listener falls through as a DOM attribute on the <ul> and the row does
//     nothing. The list is built from a type-alias union (call-signature defineEmits);
//     switching to the object form would drop the union and pass typecheck.
//   · three states hide rows — the first-run screen (Duplicate, Export), an unsaved
//     draft (the whole destructive foot), a claimed open (Forget) — and each is a prop
//     the parent computes, so a dropped `hidden` or `v-if` shows a row that acts on
//     nothing.
//   · close comes BEFORE the row's event, so a dialog the event opens never sits under
//     a menu that is still there.
//   · the site foot (#376) holds two rows that emit and two that navigate; the links
//     close the menu too.
import { describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { mount } from "@vue/test-utils";
import EditorMenu from "~/components/EditorMenu.vue";
import { blankList } from "./helpers/list";

const warmExporters = vi.fn();
mockNuxtImport("useListExports", () => () => ({
  warmExporters,
  exportItems: [
    { key: "text", label: "Copy as plain text", icon: [], run: () => Promise.resolve() },
    { key: "markdown", label: "Copy as Markdown", icon: [], run: () => Promise.resolve() },
    { key: "csv", label: "Download CSV", icon: [], run: () => Promise.resolve() },
    { key: "json", label: "Download JSON", icon: [], run: () => Promise.resolve() },
  ],
}));

const rows = (w: ReturnType<typeof mount>) => w.findAll('[role="menuitem"]').map((b) => b.text().trim());

function openMenu(props: Partial<InstanceType<typeof EditorMenu>["$props"]> = {}) {
  return mount(EditorMenu, {
    props: {
      open: true,
      firstRun: false,
      saved: true,
      openedByCode: false,
      snapshot: blankList(),
      shareUrl: "https://mahonia.app/s/ABC",
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
      ["close", "delete", "duplicate", "feedback", "flash", "forget", "import", "people", "shortcuts"].sort(),
    );
  });

  it("reads: list rows, Export, the site foot, then the destructive foot", () => {
    const w = openMenu();
    expect(rows(w)).toEqual([
      "Add people",
      "Duplicate this list",
      "Import a list…",
      "Keyboard shortcuts",
      "Send feedback…",
      "About",
      "Legal",
      "Forget this list",
      "Delete this list",
    ]);
    expect(w.get(".menu__secthead").text()).toContain("Export");
    // #376's scroller, so a short phone can still reach the foot
    expect(w.get(".menu__list").classes()).toContain("editor__actions");
    w.unmount();
  });

  it("stands Duplicate and Export down on the first-run screen", () => {
    const w = openMenu({ firstRun: true, saved: false });
    expect(rows(w)).not.toContain("Duplicate this list");
    expect(w.find(".menu__secthead").exists()).toBe(false);
    w.unmount();
  });

  it("offers the destructive foot only for a saved list, and Forget only for its own device", () => {
    const draft = openMenu({ saved: false });
    expect(rows(draft)).not.toContain("Delete this list");
    expect(rows(draft)).not.toContain("Forget this list");
    draft.unmount();

    const claimed = openMenu({ openedByCode: true });
    expect(rows(claimed)).toContain("Delete this list");
    expect(rows(claimed)).not.toContain("Forget this list");
    claimed.unmount();
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
    w.unmount();
  });

  it("closes on the site links too", async () => {
    const w = openMenu();
    await w.findAll('[role="menuitem"]').find((b) => b.text() === "About")!.trigger("click");
    expect(w.emitted().close).toHaveLength(1);
    w.unmount();
  });

  it("warms the exporters when Export opens, and reports through the parent's toast", async () => {
    warmExporters.mockClear();
    const w = openMenu();
    expect(warmExporters).not.toHaveBeenCalled();
    await w.get(".menu__secthead").trigger("click");
    expect(warmExporters).toHaveBeenCalledOnce();
    expect(rows(w)).toContain("Copy as Markdown");
    w.unmount();
  });
});
