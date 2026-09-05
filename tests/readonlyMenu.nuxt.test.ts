// @vitest-environment nuxt
//
// The read views' ⋯ menu — the one surface with no test at all, and the one whose rows
// stopped being hand-written <li>s and became a table plus a shared <MenuSection>.
//
// What that rewrite made worth pinning is not any single row's behaviour but the
// mechanisms it now leans on, each of which fails SILENTLY:
//   · a `Ref` nested inside a plain array is NOT auto-unwrapped by the template, so
//     "Duplicate" is disabled by `a.busy?.value` and not by `a.busy`. Move MENU_ACTIONS
//     into a reactive() or a computed and the binding starts reading `undefined` — the
//     button stops disabling, and nothing else changes.
//   · the export rows come from useListExports, so the two ⋯ menus can't word the same
//     format differently. A hand-written row added here would pass every other test.
//   · the exporter chunks warm when the SECTION opens, not when the menu does. The read
//     views are deliberately decoupled from the editor bundle, so a reader who opens ⋯
//     for "Copy link" must not fetch four parsers.
//   · Report is moderation, gated on a PUBLIC list that hasn't been reported yet.
import { describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { mount } from "@vue/test-utils";
import ReadonlyMenu from "~/components/ReadonlyMenu.vue";
import { blankList } from "./helpers/list";

const warmExporters = vi.fn();
const copyList = vi.fn(() => Promise.resolve(true));
const copying = ref(false);

// The real composable would pull the exporter chunks; the rows it returns are what the
// menu draws, so the stub keeps their shape (label + mark + act) and nothing else.
mockNuxtImport("useListExports", () => () => ({
  warmExporters,
  exportItems: [
    { key: "text", label: "Copy as plain text", icon: [], run: () => Promise.resolve() },
    { key: "markdown", label: "Copy as Markdown", icon: [], run: () => Promise.resolve() },
    { key: "csv", label: "Download CSV", icon: [], run: () => Promise.resolve() },
    { key: "json", label: "Download JSON", icon: [], run: () => Promise.resolve() },
  ],
}));
mockNuxtImport("useCopyList", () => () => ({ copying, copyList }));

const rows = (w: ReturnType<typeof mount>) =>
  w.findAll('[role="menuitem"]').map((b) => b.text().trim());

async function openMenu(over: Parameters<typeof blankList>[0] = {}) {
  const w = mount(ReadonlyMenu, {
    props: { snapshot: blankList(over), totals: null },
    attachTo: document.body,
  });
  await w.get('[aria-label="More actions"]').trigger("click");
  return w;
}

describe("the read views' ⋯ menu", () => {
  it("reads in the editor's order, with Export last of the body", async () => {
    const w = await openMenu();
    expect(rows(w)).toEqual(["Duplicate this list", "Copy link", "Send feedback…"]);
    // the header opens a group rather than doing anything, so it is not a menuitem
    const head = w.get(".menu__secthead");
    expect(head.text()).toContain("Export");
    expect(head.attributes("aria-expanded")).toBe("false");
    w.unmount();
  });

  it("draws the export rows from useListExports, not from its own markup", async () => {
    const w = await openMenu();
    await w.get(".menu__secthead").trigger("click");
    expect(rows(w).slice(-4)).toEqual([
      "Copy as plain text",
      "Copy as Markdown",
      "Download CSV",
      "Download JSON",
    ]);
    w.unmount();
  });

  it("warms the exporters when Export opens, not when the menu does", async () => {
    warmExporters.mockClear();
    const w = await openMenu();
    expect(warmExporters).not.toHaveBeenCalled();
    await w.get(".menu__secthead").trigger("click");
    expect(warmExporters).toHaveBeenCalledOnce();
    w.unmount();
  });

  it("disables Duplicate while a copy is in flight", async () => {
    copying.value = true;
    const w = await openMenu();
    const dup = w.findAll('[role="menuitem"]')[0]!;
    // reads `a.busy?.value` — a ref inside a plain array is not auto-unwrapped
    expect(dup.attributes("disabled")).toBeDefined();
    copying.value = false;
    await nextTick();
    expect(dup.attributes("disabled")).toBeUndefined();
    w.unmount();
  });

  it("offers Report only on a public list that hasn't been reported", async () => {
    const priv = await openMenu();
    expect(rows(priv)).not.toContain("Report list");
    priv.unmount();

    const pub = await openMenu({ isPublic: true } as Parameters<typeof blankList>[0]);
    expect(rows(pub)).toContain("Report list");
    pub.unmount();
  });

  it("closes on the action, so a row can't be pressed twice", async () => {
    const w = await openMenu();
    await w.findAll('[role="menuitem"]')[0]!.trigger("click");
    expect(w.find(".menu__list").exists()).toBe(false);
    expect(copyList).toHaveBeenCalled();
    w.unmount();
  });
});
