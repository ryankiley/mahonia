// A sign-in waits its turn. Once a day the server renews a session by re-sending
// its cookies with the answer to a session check, and a response sets cookies
// whenever it lands: a sign-in sent while a check was still out could have its new
// cookies overwritten by the old session's, a moment later. The sign-in link's page
// starts its own check as it loads, so on that page the two were always out together.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { mockNuxtImport, mountSuspended, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { createError } from "h3";
import Callback from "~/pages/auth/callback.vue";

stubLocalStorage();
enableAutoUnmount(afterEach);

// where the page sends the person afterwards is not this file's subject
mockNuxtImport("useReturnTo", () => () => ({ resume: async () => {} }));

/** The order requests reached the server in. */
const order: string[] = [];
// The session check, held at the server only while a case says so: one that held
// every check would leave the re-read AFTER a sign-in out for good, and the next
// case waiting behind it.
let hold = false;
let down = false;
let release: (() => void) | null = null;
registerEndpoint("/api/auth/me", async () => {
  order.push("me");
  if (down) throw createError({ statusCode: 503, statusMessage: "Unreachable" });
  if (hold) await new Promise<void>((r) => (release = r));
  order.push("me answered");
  return { user: { owner: "1", email: "old@example.com", displayName: null, sweep: true, account: "a" } };
});
/** Let the held check answer, and hold no more after it. */
function letGo() {
  hold = false;
  release!();
}
registerEndpoint("/api/auth/verify", {
  method: "POST",
  handler: () => {
    order.push("verify");
    return { ok: true, sweep: true };
  },
});
registerEndpoint("/api/auth/signout", {
  method: "POST",
  handler: () => {
    order.push("signout");
    return { ok: true };
  },
});
registerEndpoint("/api/lists/claim", { method: "POST", handler: () => ({ claimed: 0, lists: [] }) });
registerEndpoint("/api/lists/claimed", () => ({ lists: [] }));

beforeEach(() => {
  order.length = 0;
  hold = false;
  down = false;
  release = null;
  document.cookie = "mh_signed_in=1; path=/";
  document.cookie = "mh_session_owner=1; path=/";
  useState<unknown>("session").value = { state: "unresolved" };
  useState<boolean>("session-pending").value = false;
});
// nothing left out for the next case to wait behind
afterEach(async () => {
  await sessionSettled();
});

const until = (seen: () => boolean) => vi.waitFor(() => expect(seen()).toBe(true));

describe("a sign-in waits for the session check in front of it", () => {
  it("holds the link back until the page's own check has answered", async () => {
    // the page loads signed in as someone: its check goes out at once
    hold = true;
    const check = useSession().refresh();
    await until(() => order.includes("me"));

    await mountSuspended(Callback, { route: "/auth/callback?t=a-sign-in-token" });
    await flushPromises();
    // the check is still out, so the link has not been sent beside it
    expect(order).toEqual(["me"]);

    letGo();
    await check;
    await until(() => order.includes("verify"));
    expect(order.slice(0, 3)).toEqual(["me", "me answered", "verify"]);
  });

  it("sends the link at once when nothing is out", async () => {
    document.cookie = "mh_signed_in=; Max-Age=0; path=/"; // nobody signed in: no check to wait for
    await mountSuspended(Callback, { route: "/auth/callback?t=a-sign-in-token" });
    await until(() => order.includes("verify"));
    expect(order).toEqual(["verify"]);
  });

  it("holds a sign-out back the same way", async () => {
    hold = true;
    const check = useSession().refresh();
    await until(() => order.includes("me"));

    const out = useSession().signOut();
    await flushPromises();
    expect(order).toEqual(["me"]);

    letGo();
    await Promise.all([check, out]);
    // after the held check's answer, whatever else the app asked in between
    expect(order.slice(0, 2)).toEqual(["me", "me answered"]);
    expect(order.filter((r) => r === "signout")).toHaveLength(1);
    expect(useSession().signedIn.value).toBe(false);
  });
});

describe("sessionSettled", () => {
  it("resolves at once with nothing out", async () => {
    await expect(sessionSettled()).resolves.toBeUndefined();
    expect(order).toEqual([]);
  });

  it("never rejects when the check fails: that is no reason to refuse a sign-in", async () => {
    down = true;
    const check = useSession().refresh();
    await expect(sessionSettled()).resolves.toBeUndefined();
    await check;
    expect(useSession().loaded.value).toBe(false); // unresolved, as a failed ask is
  });
});
