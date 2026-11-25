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

// a browser with a passkey that the server accepts
mockNuxtImport("passkeysSupported", () => () => true);
mockNuxtImport("usePasskeys", () => () => ({ signIn: async () => "ok", list: async () => [] }));

registerEndpoint("/api/auth/request", { method: "POST", handler: () => ({ ok: true }) });

const CODE = "C0DE00000001";
const KEY = "gear.returnto.v1";
const home = location.pathname + location.search + location.hash;

beforeEach(() => {
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
    const view = mount(AccountView, { props: { inModal: true }, attachTo: document.body });
    await flushPromises();
    await nextTick();
    expect(storage.has(KEY)).toBe(false);

    await view.get('input[type="email"]').setValue("a@example.com");
    await view.get("form").trigger("submit");
    await flushPromises();
    expect(view.text()).toContain("Check a@example.com for a link.");
    expect(JSON.parse(storage.get(KEY)!).path).toBe(`/e/${CODE}`);
  });

  it("signs in with a passkey in place: the dialog closes and nothing navigates", async () => {
    history.replaceState(null, "", `/e/${CODE}#tok_secret`);
    const view = mount(AccountView, { props: { inModal: true }, attachTo: document.body });
    await flushPromises();
    await nextTick();
    await view.get("button.acct__wide").trigger("click");
    await flushPromises();
    expect(view.emitted("done")).toHaveLength(1);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(storage.has(KEY)).toBe(false);
  });
});
