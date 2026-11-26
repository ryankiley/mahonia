// Signing in by emailed link comes back to the page the link was asked from. #173
// remembered the page when the Sign in LINK was clicked; #174 made sign-in a dialog and
// dropped that click, so the emailed link always landed on /gear. The dialog remembers
// the page when the link is sent now, without the editor's key: that stays in the
// registry and is put back on the way out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { memoryListStore } from "./helpers/gearList";
import { listEntry } from "./helpers/myLists";
import { stubLocalStorage } from "./helpers/storage";
import AccountView from "~/components/AccountView.vue";

const storage = stubLocalStorage();
enableAutoUnmount(afterEach);

const { navigateTo } = vi.hoisted(() => ({ navigateTo: vi.fn(async (..._to: unknown[]) => {}) }));
mockNuxtImport("navigateTo", () => navigateTo);
// forgetting a list also drops its on-device record; there's no IndexedDB here
mockNuxtImport("useLocalListStore", () => () => memoryListStore());

// a browser that can offer a passkey from the address field. The offer waits (as it does
// until someone picks one) unless a test says a passkey was picked.
const { picked, refused } = vi.hoisted(() => ({ picked: { value: false }, refused: { value: false } }));
mockNuxtImport("passkeysSupported", () => () => true);
mockNuxtImport("usePasskeys", () => () => ({
  signInFromAutofill: () =>
    refused.value ? Promise.resolve("failed") : picked.value ? Promise.resolve("ok") : new Promise(() => {}),
  list: async () => [],
}));

registerEndpoint("/api/auth/request", { method: "POST", handler: () => ({ ok: true }) });

const CODE = "C0DE00000001";
const KEY = "gear.returnto.v1";
const home = location.pathname + location.search + location.hash;

beforeEach(() => {
  picked.value = false;
  refused.value = false;
  storage.clear();
  navigateTo.mockClear();
  for (const e of useMyLists().entries.value) useMyLists().forget(e.editToken);
});
afterEach(() => history.replaceState(null, "", home));

describe("the page a sign-in link was asked from", () => {
  it("is remembered from the address bar, without the editor's key", () => {
    // a list made this visit: the address was rewritten without routing
    history.replaceState(null, "", `/e/${CODE}#tok_secret`);
    useReturnTo().rememberHere();
    expect(JSON.parse(storage.get(KEY)!).path).toBe(`/e/${CODE}`);
    expect(storage.get(KEY)).not.toContain("tok_secret");
  });

  it("comes back with the key this browser holds, the way Your packs opens it", async () => {
    useMyLists().upsert(listEntry({ editToken: "tok_secret", shareCode: CODE }));
    history.replaceState(null, "", `/e/${CODE}#tok_secret`);
    useReturnTo().rememberHere();

    await useReturnTo().resume("/gear");
    expect(navigateTo).toHaveBeenCalledWith(`/e/${CODE}#tok_secret`, { replace: true });
    // one shot
    await useReturnTo().resume("/gear");
    expect(navigateTo).toHaveBeenLastCalledWith("/gear", { replace: true });
  });

  it("comes back to the bare path for a list this browser holds no key to", async () => {
    history.replaceState(null, "", `/s/${CODE}?unit=oz`);
    useReturnTo().rememberHere();
    await useReturnTo().resume("/gear");
    expect(navigateTo).toHaveBeenCalledWith(`/s/${CODE}?unit=oz`, { replace: true });

    history.replaceState(null, "", `/e/${CODE}`);
    useReturnTo().rememberHere();
    await useReturnTo().resume("/gear");
    expect(navigateTo).toHaveBeenLastCalledWith(`/e/${CODE}`, { replace: true });
  });

  it("is never the account page", () => {
    history.replaceState(null, "", "/account");
    useReturnTo().rememberHere();
    expect(storage.has(KEY)).toBe(false);
  });
});

describe("asking for a link in the sign-in dialog", () => {
  beforeEach(() => {
    document.cookie = "mh_signed_in=; Max-Age=0; path=/";
    useState("session").value = { state: "signedOut" };
  });

  it("remembers the page once the link is sent", async () => {
    history.replaceState(null, "", `/e/${CODE}#tok_secret`);
    const view = mount(AccountView, { attachTo: document.body });
    await flushPromises();
    await nextTick();
    expect(storage.has(KEY)).toBe(false);

    await view.get('input[type="email"]').setValue("a@example.com");
    await view.get("form").trigger("submit");
    await flushPromises();
    expect(view.text()).toContain("We sent a sign-in link to a@example.com.");
    expect(JSON.parse(storage.get(KEY)!).path).toBe(`/e/${CODE}`);
  });

  it("signs in with a passkey in place: the dialog closes and nothing navigates", async () => {
    history.replaceState(null, "", `/e/${CODE}#tok_secret`);
    picked.value = true; // from the address field's list: there is no passkey button
    const view = mount(AccountView, { attachTo: document.body });
    await flushPromises();
    await nextTick();
    await flushPromises();
    expect(view.emitted("done")).toHaveLength(1);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(storage.has(KEY)).toBe(false);
  });

  it("says so when a picked passkey doesn't sign in, and points at the address field", async () => {
    refused.value = true;
    const view = mount(AccountView, { attachTo: document.body });
    await flushPromises();
    await nextTick();
    await flushPromises();
    expect(view.get('[role="alert"]').text()).toBe(
      "That passkey didn’t sign you in. Continue with your email instead.",
    );
    expect(view.emitted("done")).toBeUndefined();
  });
});
