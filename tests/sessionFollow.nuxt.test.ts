// A session changed in another tab. Signing in or out there changes the cookies under
// this tab, which went on with the answer it had until a reload. It now compares the
// cookies with what it knows when it comes back into view or takes focus, and asks
// only when they differ. These cases count what that costs.
//
// The app's own session plugin is what listens here; nothing is mounted. The server is
// the only double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { flushPromises } from "@vue/test-utils";
import { stubLocalStorage } from "./helpers/storage";

stubLocalStorage();

let signedInAs: { owner: string; account: string } | null = null;
let asks = 0; // requests to /api/auth/me
registerEndpoint("/api/auth/me", () => {
  asks++;
  return { user: signedInAs && { ...signedInAs, email: "a@example.com", displayName: null, sweep: false } };
});
registerEndpoint("/api/auth/signout", { method: "POST", handler: () => ((signedInAs = null), {}) });
registerEndpoint("/api/lists/claimed", () => ({ lists: [] }));

/** The cookies a sign-in leaves, in whichever tab it finished. */
function cookiesFor(owner: string, account: string) {
  signedInAs = { owner, account };
  document.cookie = "mh_signed_in=1; path=/";
  document.cookie = `mh_session_owner=${owner}; path=/`;
}
/** A sign-out in another tab: its cookies go. */
function signedOutElsewhere() {
  signedInAs = null;
  document.cookie = "mh_signed_in=; Max-Age=0; path=/";
  document.cookie = "mh_session_owner=; Max-Age=0; path=/";
}
/** Signed in here, and this tab knows it. */
async function signIn(owner: string, account: string) {
  cookiesFor(owner, account);
  await useSession().refresh(true);
  expect(useSession().user.value?.account).toBe(account);
  asks = 0;
}
const intoView = () => document.dispatchEvent(new Event("visibilitychange"));
const takeFocus = () => window.dispatchEvent(new Event("focus"));
/** Long enough for anything that was going to be asked to have been. */
const settle = async () => {
  await flushPromises();
  await new Promise((r) => setTimeout(r, 50));
};

beforeEach(() => {
  asks = 0;
});
afterEach(async () => {
  Reflect.deleteProperty(document, "visibilityState");
  signedInAs = null;
  await useSession().signOut();
  await settle();
});

describe("a tab coming back to a session another tab changed", () => {
  it("asks nothing when the cookies still name the session it knows", async () => {
    await signIn("1", "aaaa");
    intoView();
    takeFocus();
    await settle();
    expect(asks).toBe(0);
    expect(useSession().user.value?.account).toBe("aaaa");
  });

  it("asks once when another account has signed in, however many ways it came back", async () => {
    await signIn("1", "aaaa");
    cookiesFor("2", "bbbb");
    intoView();
    takeFocus();
    await vi.waitFor(() => expect(useSession().user.value?.account).toBe("bbbb"));
    await settle();
    expect(asks).toBe(1);
  });

  it("learns of a sign-out with no request at all", async () => {
    await signIn("1", "aaaa");
    signedOutElsewhere();
    intoView();
    await vi.waitFor(() => expect(useSession().presence.value).toBe("signedOut"));
    await settle();
    expect(asks).toBe(0);
  });

  it("asks once when it was signed out and a sign-in has happened, on taking focus alone", async () => {
    await useSession().refresh(true); // no cookies: signed out, and known to be
    expect(useSession().presence.value).toBe("signedOut");
    cookiesFor("1", "aaaa");
    takeFocus();
    await vi.waitFor(() => expect(useSession().user.value?.account).toBe("aaaa"));
    await settle();
    expect(asks).toBe(1);
  });

  it("asks nothing while it is not in view", async () => {
    await signIn("1", "aaaa");
    cookiesFor("2", "bbbb");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    takeFocus();
    intoView();
    await settle();
    expect(asks).toBe(0);
    expect(useSession().user.value?.account).toBe("aaaa");
  });
});
