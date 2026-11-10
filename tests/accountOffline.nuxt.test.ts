// The account panel offline. With the signed-in hint and no network, /api/auth/me never
// answers, so the session stays unresolved and the panel drew neither the sign-in form
// nor the account: "Loading…" for good, on /account (which now opens offline) and in
// the account dialog alike.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import AccountView from "~/components/AccountView.vue";

enableAutoUnmount(afterEach);

const setCookie = (name: string, value: string | null) =>
  (document.cookie = value === null ? `${name}=; Max-Age=0; path=/` : `${name}=${value}; path=/`);

beforeEach(() => {
  setCookie("mh_signed_in", "1");
  useState("session").value = { state: "unresolved" };
});
afterEach(() => setCookie("mh_signed_in", null));

async function open() {
  const wrapper = mount(AccountView);
  await flushPromises();
  await nextTick();
  return wrapper;
}

describe("the account panel offline", () => {
  it("says it's offline once the ask has failed, rather than loading for good", async () => {
    useState("session-pending").value = false;
    const view = await open();
    expect(view.text()).toContain("You’re offline. Your account opens once you’re back online.");
    expect(view.text()).not.toContain("Loading…");
  });

  it("still says Loading while the ask is out", async () => {
    useState("session-pending").value = true;
    const view = await open();
    expect(view.text()).toContain("Loading…");
    expect(view.text()).not.toContain("You’re offline");
  });
});
