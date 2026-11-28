// My Gear's Sharing panel: the list's link row, and Stop sharing only while there is a
// link to stop. The panel closes before it hands the act to the page, as the list's does.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import VaultSharePanel from "~/components/VaultSharePanel.vue";

enableAutoUnmount(afterEach);

const labels = (w: ReturnType<typeof mount>) => w.findAll("[data-row]").map((r) => r.attributes("aria-label") ?? r.text());

describe("My Gear's Sharing panel", () => {
  it("offers Stop sharing only while the link is on", () => {
    expect(labels(mount(VaultSharePanel, { props: { sharing: true } }))).toEqual(["Copy read-only link", "Stop sharing"]);
    expect(labels(mount(VaultSharePanel, { props: { sharing: false } }))).toEqual(["Copy read-only link"]);
    // not yet known: nothing it can't stand behind
    expect(labels(mount(VaultSharePanel, { props: { sharing: null } }))).toEqual(["Copy read-only link"]);
  });

  it("closes, then hands the copy or the stop to the page", async () => {
    const w = mount(VaultSharePanel, { props: { sharing: true } });
    const rows = w.findAll("[data-row]");
    await rows[0]!.trigger("click");
    await rows[1]!.trigger("click");
    expect(Object.keys(w.emitted())).toEqual(expect.arrayContaining(["close", "copy", "stop"]));
    expect(w.emitted("close")).toHaveLength(2);
  });
});
