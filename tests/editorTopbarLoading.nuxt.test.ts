// The editor's top bar while a list LOADS from the network (no copy on the device: a list
// made on another device, opened here for the first time). It used to drop to the switcher
// alone for the length of the load and pop back when the list landed, and because the icon
// buttons were what gave the bar its height, everything under it rode up and back down.
// Pinned here, on the real editor and the real controller, with the list's answer held:
//   - the controls stay up, marked unavailable to a screen reader, and do nothing until the
//     list is there (opening only; nothing opens itself when it lands)
//   - the status line says nothing, and the page's "Loading…" keeps quiet for 300 ms
//   - a load that ENDS with no list is a real state, and the bar stands down for it
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, mountSuspended, registerEndpoint } from "@nuxt/test-utils/runtime";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { createError, getRequestHeader } from "h3";
import { memoryListStore, quietVaultAccess } from "./helpers/gearList";
import { snapshotFor } from "./helpers/list";
import { stubLocalStorage } from "./helpers/storage";
import GearEditor from "~/components/GearEditor.client.vue";

// nothing on the device, so every open goes to the network
mockNuxtImport("useLocalListStore", () => () => memoryListStore());
mockNuxtImport("useVaultAccess", () => () => quietVaultAccess());
stubLocalStorage();

const CODE = "AHEAD0000001";
const TOKEN = "slow-list-token";
const GONE = "deleted-list-token";
// the list's answer, held until a case lets it go
let release: (() => void) | undefined;
registerEndpoint("/api/edit/list", async (event) => {
  if (getRequestHeader(event, "authorization") === `Bearer ${GONE}`) throw createError({ statusCode: 404 });
  await new Promise<void>((resolve) => (release = resolve));
  return { snapshot: snapshotFor({ shareCode: CODE, slug: "slow-aaa111", title: "Slow list" }) };
});
registerEndpoint("/api/edit/changes", () => ({ version: 1 }));
registerEndpoint("/api/catalog/use", () => ({}));

let wrapper: VueWrapper | undefined;
beforeEach(() => {
  release = undefined;
});
afterEach(() => {
  release?.();
  wrapper?.unmount();
  useGearList().dispose();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bar = () => wrapper!.find(".topbar__inner");
const button = (label: string) => wrapper!.find(`.topbar button[aria-label="${label}"]`);

describe("the top bar while a list loads from the network", () => {
  it("keeps its controls, inert and marked, with nothing said yet", async () => {
    wrapper = await mountSuspended(GearEditor, { route: `/e/${CODE}#${TOKEN}` });
    await flushPromises();
    expect(useGearList().status.value).toBe("loading");

    expect(bar().find(".topbar__status").exists()).toBe(true);
    for (const label of ["My Gear", "Sharing", "More actions"]) {
      expect(button(label).exists()).toBe(true);
      expect(button(label).attributes("aria-disabled")).toBe("true");
      // aria-disabled, never `disabled`: the attribute dims a button, and the dimming is the flash
      expect(button(label).attributes("disabled")).toBeUndefined();
    }
    // the status line has nothing to say about a load
    expect(wrapper.find(".syncstatus").exists()).toBe(false);

    // taps do nothing, and nothing opens itself when the list lands
    await button("Sharing").trigger("click");
    await button("More actions").trigger("click");
    await button("My Gear").trigger("click");
    expect(button("Sharing").attributes("aria-expanded")).toBe("false");
    expect(button("More actions").attributes("aria-expanded")).toBe("false");

    // "Loading…" holds its line, hidden, then says it once the wait is long enough
    const loading = wrapper.find(".editor__loading");
    expect(loading.exists()).toBe(true);
    expect(loading.classes()).not.toContain("is-said");
    await wait(350);
    expect(wrapper.find(".editor__loading").classes()).toContain("is-said");

    release!();
    await flushPromises();
    await wait(0);
    expect(wrapper.find(".editor__body").exists()).toBe(true);
    expect(button("Sharing").attributes("aria-disabled")).toBeUndefined();
    expect(button("My Gear").attributes("aria-expanded")).toBe("false");
    // ...and once it's here they work
    await button("Sharing").trigger("click");
    expect(button("Sharing").attributes("aria-expanded")).toBe("true");
  });

  it("keeps them through a truncated link to your own list, while its key is put back", async () => {
    // this browser holds the key for CODE, so /e/{code} restores the fragment, then loads
    useMyLists().registerCreated(
      { editToken: TOKEN, snapshot: snapshotFor({ shareCode: CODE, slug: "slow-aaa111", title: "Slow list" }) },
      0,
      "opened",
    );
    wrapper = await mountSuspended(GearEditor, { route: `/e/${CODE}` });
    // before the load has started ("idle") and while it runs ("loading") alike
    expect(["idle", "loading"]).toContain(useGearList().status.value);
    expect(bar().find(".topbar__status").exists()).toBe(true);
    expect(button("Sharing").attributes("aria-disabled")).toBe("true");
    // the key is back and the load is out
    await vi.waitUntil(() => release, { timeout: 2000 });
    expect(useGearList().status.value).toBe("loading");
    expect(bar().find(".topbar__status").exists()).toBe(true);
    release!();
    await vi.waitUntil(() => useGearList().snapshot.value, { timeout: 2000 });
    expect(useGearList().snapshot.value?.title).toBe("Slow list");
  });

  it("stands down for a list that won't open", async () => {
    wrapper = await mountSuspended(GearEditor, { route: `/e/${CODE}#${GONE}` });
    await flushPromises();
    await wait(0);
    expect(useGearList().status.value).toBe("missing");
    expect(bar().find(".topbar__status").exists()).toBe(false);
    expect(button("Sharing").exists()).toBe(false);
    expect(wrapper.find(".editor__missing").text()).toContain("isn’t in this browser");
  });
});
