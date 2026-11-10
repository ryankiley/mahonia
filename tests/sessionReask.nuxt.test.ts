// The session asked again after an offline launch. With the signed-in hint and no
// network, /api/auth/me fails and the session stays "presumed"; nothing asked again
// until a reload, so My Gear, the account page and the switcher's account rows all
// stayed on their offline answers after the signal came back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { useSessionReask } from "~/composables/useSession";

const OWNER = "a1b2c3d4e5f60718";
registerEndpoint("/api/auth/me", () => ({ user: { owner: OWNER, email: "a@b.c", displayName: null } }));

enableAutoUnmount(afterEach);

const Harness = defineComponent({ setup: () => useSessionReask(), render: () => null });

beforeEach(() => {
  document.cookie = "mh_signed_in=1; path=/";
  // as an offline launch leaves it: asked, and the ask failed
  useState("session").value = { state: "unresolved" };
  useState("session-pending").value = false;
  useState("session-ask-failed").value = true;
});
afterEach(() => {
  document.cookie = "mh_signed_in=; Max-Age=0; path=/";
  document.cookie = "mh_session_owner=; Max-Age=0; path=/";
  Reflect.deleteProperty(document, "visibilityState");
});

describe("asking for the session again", () => {
  it("asks when the tab comes back into view, with no online event", async () => {
    mount(Harness);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(useSession().presence.value).toBe("signedIn"));
  });

  it("asks on the online event too", async () => {
    mount(Harness);
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(useSession().presence.value).toBe("signedIn"));
  });

  // Unresolved because nothing has asked yet is not offline: the plugin's own first ask
  // is on its way.
  it("doesn't ask before an ask has failed", async () => {
    useState("session-ask-failed").value = false;
    mount(Harness);
    window.dispatchEvent(new Event("online"));
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));
    expect(useSession().presence.value).toBe("presumed");
  });

  it("doesn't ask from a hidden tab", async () => {
    mount(Harness);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    window.dispatchEvent(new Event("online"));
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));
    expect(useSession().pending.value).toBe(false);
    expect(useSession().presence.value).toBe("presumed");
  });
});
