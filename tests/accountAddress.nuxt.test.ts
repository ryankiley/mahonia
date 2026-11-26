// ONE SIGN-IN DESIGN. The form was drawn twice: in the account dialog, and bare on a
// page at /account for the arrivals with nothing underneath (a typed or bookmarked
// address, the dead sign-in link's "Get a new link"), and the page a sign-in link lands
// on asked its questions as centred lines on a bare page. The address now opens the
// dialog over the bare address's page, and the link's questions are asked in the same
// sign-in card over the page the link was asked from.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { mockNuxtImport, mountSuspended, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises } from "@vue/test-utils";
import { createError } from "h3";
import Account from "~/pages/account.vue";
import SignInLinkDialog from "~/components/SignInLinkDialog.vue";
import Callback from "~/pages/auth/callback.vue";

stubLocalStorage();
enableAutoUnmount(afterEach);

const { navigateTo } = vi.hoisted(() => ({ navigateTo: vi.fn(async () => {}) }));
mockNuxtImport("navigateTo", () => navigateTo);

// the server's answer to a sign-in link: whatever a test says, a spent link otherwise
type Verify =
  | { fails: true }
  | { ok: true; sweep: boolean }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "confirm"; email: string; asked: boolean; evicts: boolean };
let verify: Verify = { ok: false, reason: "invalid" };
/** how many times the link has reached the server */
let verifyAsked = 0;
registerEndpoint("/api/auth/verify", {
  method: "POST",
  handler: () => {
    verifyAsked++;
    if ("fails" in verify) throw createError({ statusCode: 500, statusMessage: "No" });
    return verify;
  },
});
registerEndpoint("/api/auth/me", () => ({
  user: { owner: "1", email: "a@example.com", displayName: null, sweep: true, account: "a" },
}));
registerEndpoint("/api/lists/claim", { method: "POST", handler: () => ({ claimed: 0, lists: [] }) });
registerEndpoint("/api/lists/claimed", () => ({ lists: [] }));

beforeEach(() => {
  verify = { ok: false, reason: "invalid" };
  navigateTo.mockClear();
  localStorage.clear();
  useSignInLink().state.open = false;
  useAccountModal().close();
  document.cookie = "mh_signed_in=; Max-Age=0; path=/";
  useState<unknown>("session").value = { state: "signedOut" };
});

describe("/account", () => {
  it("opens the account dialog over the bare address's page", async () => {
    const page = await mountSuspended(Account, { route: "/account" });
    await flushPromises();
    expect(useAccountModal().state.open).toBe(true);
    expect(navigateTo).toHaveBeenCalledWith("/", { replace: true });
    // and draws no account of its own
    expect(page.find(".acct").exists()).toBe(false);
    expect(page.find("form").exists()).toBe(false);
  });

  it("mounts the form nowhere but the dialog and the /authorize step", () => {
    const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");
    expect(read("app/pages/account.vue")).not.toContain("<AccountView");
    expect(read("app/components/AccountModal.vue")).toContain("<AccountView");
    expect(read("app/pages/authorize.vue")).toContain("<AccountView as-step />");
  });
});

// A LINK'S QUESTIONS ARE ASKED OVER THE PRIOR VIEW. The link opens in a fresh tab with
// nothing before it, and its questions were asked there, in a card over an empty page.
// The page the link was asked from is remembered, so a question goes there first (or to
// the bare address) and is asked over it. The straight run asks nothing and keeps its
// order: sign in, then go back, so the page you return to mounts signed in.
describe("the page a sign-in link lands on", () => {
  const link = () => useSignInLink().state;
  async function arrived(route = "/auth/callback?t=a-sign-in-token") {
    const page = await mountSuspended(Callback, { route });
    await flushPromises();
    await flushPromises();
    return page;
  }

  it("draws no question of its own, and its one card only from a timer in the browser", async () => {
    verify = { fails: true };
    const page = await arrived();
    expect(page.find('[role="dialog"]').exists()).toBe(false);
    expect(page.get("main").text()).toBe("");
    // open during the server render, the dialog shell answered every link with a 500
    const source = readFileSync(resolve(__dirname, "../app/pages/auth/callback.vue"), "utf8");
    expect(source).toContain('<BaseModal :open="slow"');
    expect(source).toMatch(/onMounted\(\(\) => \{\s*waiting = setTimeout\(\(\) => \(slow\.value = true\), SLOW_MS\);/);
  });

  it("signs in and goes straight back when there is nothing to ask", async () => {
    verify = { ok: true, sweep: true };
    await arrived();
    expect(link().open).toBe(false);
    // nowhere remembered: the one thing an account is for
    expect(navigateTo.mock.calls).toEqual([["/gear", { replace: true }]]);
  });

  it("goes to the page the link was asked from before it asks anything", async () => {
    history.replaceState(null, "", "/s/C0DE00000001");
    useReturnTo().rememberHere();
    history.replaceState(null, "", "/");
    verify = { fails: true };
    await arrived();
    expect(navigateTo.mock.calls).toEqual([["/s/C0DE00000001", { replace: true }]]);
    expect(link().open).toBe(true);
    expect(link().question).toBe("error");
  });

  it("asks over the bare address when no page is remembered", async () => {
    verify = { ok: false, reason: "confirm", email: "a@example.com", asked: true, evicts: false };
    await arrived();
    expect(navigateTo.mock.calls).toEqual([["/", { replace: true }]]);
    expect(link().open).toBe(true);
    expect(link().question).toBe("confirm");
    expect(link().asking.email).toBe("a@example.com");
  });

  // A dead link has one way on, a new one. It was a screen of its own with one button
  // whose only job was to open the form; now it IS the form, titled for what happened.
  it.each([
    ["with no token", "/auth/callback"],
    ["the server calls spent", "/auth/callback?t=a-sign-in-token"],
  ])("goes straight to the form for a new link, for a link %s", async (_name, route) => {
    verify = { ok: false, reason: "invalid" };
    await arrived(route);
    expect(useAccountModal().state.open).toBe(true);
    expect(useAccountModal().state.notice).toBe("expired");
    expect(navigateTo.mock.calls).toEqual([["/", { replace: true }]]);
    expect(link().open).toBe(false);
  });
});

describe("the dialog a sign-in link asks in", () => {
  async function asked(answer: typeof verify) {
    verify = answer;
    await mountSuspended(Callback, { route: "/auth/callback?t=a-sign-in-token" });
    await flushPromises();
    await flushPromises();
    navigateTo.mockClear();
    const dialog = await mountSuspended(SignInLinkDialog);
    await flushPromises();
    return dialog;
  }

  it("is the sign-in card, titled for the question", async () => {
    const w = await asked({ ok: false, reason: "confirm", email: "a@example.com", asked: true, evicts: true });
    const card = w.get('[role="dialog"]');
    expect(card.attributes("aria-label")).toBe("Sign in as a@example.com?");
    expect(card.get(".signin__head h2").text().replace(/\s+/g, " ")).toBe("Sign in as a@example.com?");
    // the title may break only in front of the address, never between "in" and "as"
    expect(card.get(".signin__head h2 .signin__keep").text()).toBe("Sign in as");
    expect(card.find(".signin__head svg.signin__mark").exists()).toBe(true);
    // one sentence: who should press it. Nothing about passkeys, even where the server
    // says signing in will remove them: the browser that asked never saw that line.
    expect(card.findAll(".signin__body p")).toHaveLength(1);
    expect(card.get(".signin__body p").text().replace(/\s+/g, " ")).toBe(
      "Only sign in if you asked for this link in another browser.",
    );
    expect(card.text()).not.toMatch(/passkey/i);
    expect(w.findAll(".signin__actions button").map((b) => b.text())).toEqual(["Sign in", "Not me"]);
  });

  it("asks only whether the address is yours for a link nobody's browser asked for", async () => {
    const w = await asked({ ok: false, reason: "confirm", email: "a@example.com", asked: false, evicts: false });
    expect(w.get(".signin__body p").text().replace(/\s+/g, " ")).toBe("Only sign in if this address is yours.");
  });

  it("holds the yes until the question has been on screen a moment", async () => {
    const w = await asked({ ok: false, reason: "confirm", email: "a@example.com", asked: true, evicts: false });
    expect(w.get(".signin__actions .btn--primary").attributes("disabled")).toBeDefined();
  });

  it("leaves you on the page underneath for a no: nothing signed in, nowhere to go", async () => {
    const w = await asked({ ok: false, reason: "confirm", email: "a@example.com", asked: true, evicts: false });
    await w.get(".signin__actions .btn--soft").trigger("click");
    await flushPromises();
    expect(useSignInLink().state.open).toBe(false);
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("takes Escape as the same no", async () => {
    await asked({ fails: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(useSignInLink().state.open).toBe(false);
    expect(navigateTo).not.toHaveBeenCalled();
    expect(useAccountModal().state.open).toBe(false);
  });

  // ONE BUTTON. It offered "Try again" over "Get a new link" under a line that only named
  // them again, and nothing said how they differed. The retry is the button; a retry that
  // fails too goes on by itself to the form for a new link.
  it("offers one thing when the sign-in fails: try again", async () => {
    const w = await asked({ fails: true });
    expect(w.get(".signin__head h2").text()).toBe("Couldn’t sign you in");
    // what happened, and no word on whether the link survived: a failed request can't know
    expect(w.get(".signin__body p").text()).toBe("Something went wrong on the way.");
    expect(w.text()).not.toMatch(/still good/);
    const buttons = w.findAll(".signin__actions button");
    // named for what it tries: "Try again" alone was read as asking for another email
    expect(buttons.map((b) => b.text())).toEqual(["Try signing in again"]);
    expect(buttons[0]!.classes()).toContain("btn--primary");
  });

  // A press that only greyed the button looked like a press that did nothing.
  it("says it is signing in while the retry is out", async () => {
    const w = await asked({ fails: true });
    useSignInLink().state.busy = true;
    await nextTick();
    const button = w.get(".signin__actions .btn--primary");
    expect(button.text()).toBe("Signing in…");
    expect(button.attributes("disabled")).toBeDefined();
    useSignInLink().state.busy = false;
  });

  it("moves on to the form for a new link when the retry fails too", async () => {
    const w = await asked({ fails: true });
    await w.get(".signin__actions .btn--primary").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(useSignInLink().state.open).toBe(false);
    expect(useAccountModal().state.open).toBe(true);
    expect(useAccountModal().state.notice).toBe("failed");
    // right here, over the same page
    expect(navigateTo).not.toHaveBeenCalled();
  });

  // OFFLINE IS KNOWN BEFORE THE LINK IS SENT. It was sent anyway, failed, and was
  // reported as a sign-in that "couldn't" happen.
  describe("opened with no network", () => {
    let online: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
      verifyAsked = 0;
    });
    afterEach(() => online.mockRestore());

    it("does not send the link, and says you're offline, not that it failed", async () => {
      const w = await asked({ ok: true, sweep: true });
      expect(verifyAsked).toBe(0);
      expect(w.get(".signin__head h2").text()).toBe("You’re offline");
      expect(w.get(".signin__body p").text()).toBe("You’ll be signed in when you’re back online.");
      expect(w.findAll(".signin__actions button").map((b) => b.text())).toEqual(["Try signing in again"]);
    });

    it("stays put however often it is pressed: a new link can't be asked for offline either", async () => {
      const w = await asked({ fails: true });
      for (let i = 0; i < 3; i++) {
        await w.get(".signin__actions .btn--primary").trigger("click");
        await flushPromises();
      }
      expect(verifyAsked).toBe(0);
      expect(useSignInLink().state.open).toBe(true);
      expect(useAccountModal().state.open).toBe(false);
    });

    it("signs in by itself when the connection comes back", async () => {
      await asked({ ok: true, sweep: true });
      online.mockReturnValue(true);
      window.dispatchEvent(new Event("online"));
      await flushPromises();
      await flushPromises();
      expect(verifyAsked).toBe(1);
      expect(useSignInLink().state.open).toBe(false);
    });
  });

  // One sentence: what adding them gets you, and whose account it is. It was two, the
  // first only announcing the sign-in, and a failure added a third.
  it("asks about this browser's lists in one sentence that names the account", async () => {
    const w = await asked({ fails: true });
    const s = useSignInLink().state;
    s.asking = { email: "a@example.com", asked: true };
    s.question = "lists";
    await nextTick();
    expect(w.get(".signin__head h2").text()).toMatch(/^Add this browser’s lists? to your account\?$/);
    expect(w.findAll(".signin__body p")).toHaveLength(1);
    expect(w.get(".signin__body p").text()).toMatch(/^(It|They)’ll open anywhere you sign in as a@example\.com\.$/);

    s.addFailed = true;
    await nextTick();
    const failed = w.get('.signin__body [role="alert"]');
    expect(failed.classes()).toEqual(expect.arrayContaining(["errtip", "errtip--nopoint"]));
    expect(failed.text()).toMatch(/^Couldn’t add (it|them)\. Try again\.$/);
    s.addFailed = false;
  });

  it("signs in on a retry that works, and stays on the page it was asked over", async () => {
    history.replaceState(null, "", "/s/C0DE00000001");
    useReturnTo().rememberHere();
    history.replaceState(null, "", "/");
    const w = await asked({ fails: true });
    verify = { ok: true, sweep: true };
    await w.get(".signin__actions .btn--primary").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(useSignInLink().state.open).toBe(false);
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
