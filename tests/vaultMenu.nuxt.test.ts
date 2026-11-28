// My Gear's ⋯ menu had no way to send feedback, while Help points people at "Send
// feedback…" in the editor's ⋯ menu. The row sits where the editor's does: first in
// the site foot, above Help, About and Legal, for everyone.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import VaultMenu from "~/components/VaultMenu.vue";

enableAutoUnmount(afterEach);

async function openMenu(props: { signedIn?: boolean; canExport?: boolean } = {}) {
  const w = mount(VaultMenu, { props, attachTo: document.body });
  await w.get(".menu__btn").trigger("click");
  return w;
}
const rows = (w: Awaited<ReturnType<typeof openMenu>>) => w.findAll('[role="menuitem"]').map((r) => r.text());

describe("My Gear's ⋯ menu", () => {
  it("offers Send feedback at the head of the site foot, signed out too", async () => {
    expect(rows(await openMenu())).toEqual(["Create a list", "Send feedback…", "Help", "About", "Legal"]);
    expect(rows(await openMenu({ signedIn: true, canExport: true }))).toEqual([
      "Create a list",
      "Import gear…",
      "Share my gear…",
      "Download CSV",
      "Download JSON",
      "Send feedback…",
      "Help",
      "About",
      "Legal",
    ]);
  });

  it("offers the gear link only when there is gear to share", async () => {
    expect(rows(await openMenu({ signedIn: true, canExport: false }))).not.toContain("Share my gear…");
    const w = await openMenu({ signedIn: true, canExport: true });
    await w.findAll('[role="menuitem"]').find((r) => r.text() === "Share my gear…")!.trigger("click");
    expect(w.emitted("pick")).toEqual([["share"]]);
  });

  it("closes and tells the page which row was picked", async () => {
    const w = await openMenu();
    await w.findAll('[role="menuitem"]').find((r) => r.text() === "Send feedback…")!.trigger("click");
    expect(w.emitted("pick")).toEqual([["feedback"]]);
    expect(w.find('[role="menu"]').exists()).toBe(false);
  });
});
