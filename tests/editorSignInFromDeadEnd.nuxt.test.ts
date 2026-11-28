// /e/{code} with no key in the link and nobody signed in: the address of every list an
// account holds, as the switcher writes it, once the session on this device has lapsed.
// The page said "This edit link is incomplete" and offered the read-only view or a new
// list, and the one thing that gets the owner back in, signing in, was not on it.
// Pinned here on the real editor and the real controller:
//   - the page says signing in is a way on, and has a button that opens the account
//   - signing in from there (a passkey: no address changes, nothing reloads) opens the
//     same address as one of the account's lists, without a second visit
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, mountSuspended, registerEndpoint } from "@nuxt/test-utils/runtime";
import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { memoryListStore, quietVaultAccess } from "./helpers/gearList";
import { snapshotFor } from "./helpers/list";
import { stubLocalStorage } from "./helpers/storage";
import GearEditor from "~/components/GearEditor.client.vue";

mockNuxtImport("useLocalListStore", () => () => memoryListStore());
mockNuxtImport("useVaultAccess", () => () => quietVaultAccess());
stubLocalStorage();

const CODE = "CLAIMED00001";
// how many times the list was asked for: a keyless address asks for nothing
let asked = 0;
registerEndpoint("/api/edit/list", () => {
  asked++;
  return { snapshot: snapshotFor({ shareCode: CODE, slug: "mine-aaa111", title: "Mine" }) };
});
registerEndpoint("/api/edit/changes", () => ({ version: 1 }));
registerEndpoint("/api/catalog/use", () => ({}));

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  useGearList().dispose();
  useAccountModal().close();
  useState("session").value = { state: "signedOut" };
  asked = 0;
});

describe("an edit address with no key, signed out", () => {
  it("offers signing in, and opens the list from the account once you have", async () => {
    wrapper = await mountSuspended(GearEditor, { route: `/e/${CODE}` });
    await flushPromises();
    expect(useGearList().status.value).toBe("missing");
    expect(asked).toBe(0);

    const missing = wrapper.find(".editor__missing");
    expect(missing.text()).toContain("If the list is on your account, sign in.");
    const signIn = missing.findAll("button").find((b) => b.text() === "Sign in");
    expect(signIn).toBeDefined();
    await signIn!.trigger("click");
    expect(useAccountModal().state.open).toBe(true);

    // signed in through the dialog: the address is the same one, and it opens now
    useState("session").value = {
      state: "signedIn",
      user: { owner: "1", email: "a@b.c", displayName: null, sweep: true, account: "1" },
    };
    await vi.waitUntil(() => useGearList().snapshot.value, { timeout: 2000 });
    expect(asked).toBe(1);
    expect(useGearList().openedByCode.value).toBe(true);
    expect(useGearList().snapshot.value?.title).toBe("Mine");
    expect(wrapper.find(".editor__missing").exists()).toBe(false);
  });
});
