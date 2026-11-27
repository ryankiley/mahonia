// ONE DOOR. Signed out there were two forms, Sign in and Create an account behind a
// "New here?" switch, and the person had to know which they were. The emailed link never
// needed telling (the server finds the account or makes it, with one answer for both), so
// there is one form, titled for both: an address and Continue. A passkey has no button or
// link of its own: the browser offers it from the address field's autofill list
// (passkeyAutofill covers the request).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createError } from "h3";
import AccountView from "~/components/AccountView.vue";

const { supported } = vi.hoisted(() => ({ supported: { value: true } }));
mockNuxtImport("passkeysSupported", () => () => supported.value);

enableAutoUnmount(afterEach);

// what the server says to a request for a link: ok, unless a test says otherwise
let refuse = 0;
let asked = 0;
registerEndpoint("/api/auth/request", {
  method: "POST",
  handler: () => {
    asked++;
    if (refuse) throw createError({ statusCode: refuse, statusMessage: "No" });
    return { ok: true };
  },
});

beforeEach(() => {
  refuse = 0;
  asked = 0;
  document.cookie = "mh_signed_in=; Max-Age=0; path=/";
  useState("session").value = { state: "signedOut" };
});

async function signedOut(canPasskey: boolean) {
  supported.value = canPasskey;
  const view = mount(AccountView, { attachTo: document.body });
  await flushPromises();
  await nextTick();
  return view;
}
const words = (view: Awaited<ReturnType<typeof signedOut>>) => view.get(".acct__empty").text().replace(/\s+/g, " ");
/** The title the panel last told its mount to wear. It draws none itself: the dialog
 *  (or the page it is a step of) titles it. */
const heading = (view: Awaited<ReturnType<typeof signedOut>>) =>
  (view.emitted("update:heading") as string[][] | undefined)?.at(-1)?.[0];

describe("the signed-out account form", () => {
  it("is one form, with no switch to a second", async () => {
    const view = await signedOut(true);
    expect(view.findAll(".acct__empty form")).toHaveLength(1);
    expect(words(view)).not.toContain("Create an account");
    expect(words(view)).not.toContain("Already have an account");
  });

  it("is an address and Continue, the one button", async () => {
    const view = await signedOut(true);
    const buttons = view.findAll(".acct__empty button");
    expect(buttons.map((b) => b.text())).toEqual(["Continue"]);
    expect(buttons[0]!.classes()).toContain("btn--primary");
    expect(view.get('.acct__empty input[type="email"]').attributes("aria-label")).toBe("Email address");
  });

  it("marks the address field for the browser's passkey list", async () => {
    const view = await signedOut(true);
    // "webauthn" last, as the autocomplete attribute requires of it
    expect(view.get('.acct__empty input[type="email"]').attributes("autocomplete")).toBe("username webauthn");
  });

  it("has no passkey button, link or rule, whether or not the browser can use one", async () => {
    for (const canPasskey of [true, false]) {
      const view = await signedOut(canPasskey);
      expect(words(view)).not.toMatch(/passkey/i);
      expect(view.find(".acct__or").exists()).toBe(false);
      view.unmount();
    }
  });

  it("ends at Continue: no line under the form", async () => {
    const view = await signedOut(true);
    // the title says a first visit is welcome, so nothing below the button has to
    expect(view.get(".acct__empty").element.lastElementChild?.tagName).toBe("FORM");
    expect(words(view)).not.toMatch(/new or returning|New here/);
  });

  it("is headed for both, sign in or sign up", async () => {
    supported.value = true;
    const view = mount(AccountView, { attachTo: document.body });
    await flushPromises();
    await nextTick();
    expect(heading(view)).toBe("Sign in or sign up");
    // and draws no heading of its own for the mount to double
    expect(view.find("h1").exists()).toBe(false);
  });
});

// ONCE THE LINK IS SENT the form steps aside. It stayed up, with the address still in the
// field and Continue live again, under a line saying to check the mail.
describe("after the link is sent", () => {
  async function sent() {
    supported.value = false;
    const view = mount(AccountView, { attachTo: document.body });
    await flushPromises();
    await nextTick();
    await view.get('input[type="email"]').setValue("a@example.com");
    await view.get("form").trigger("submit");
    await flushPromises();
    return view;
  }

  it("shows where it went, and nothing of the form", async () => {
    const view = await sent();
    expect(heading(view)).toBe("Check your email");
    expect(words(view)).toContain("We sent a sign-in link to a@example.com. It works once and lasts 15 minutes.");
    expect(view.find("form").exists()).toBe(false);
    expect(view.find('input[type="email"]').exists()).toBe(false);
    expect(words(view)).not.toContain("An account saves your gear");
  });

  it("has one way on, contained: back to the form with the address still in it", async () => {
    const view = await sent();
    const buttons = view.findAll(".acct__empty button");
    expect(buttons.map((b) => b.text())).toEqual(["Use a different address"]);
    expect(buttons[0]!.classes()).toEqual(expect.arrayContaining(["btn", "btn--soft"]));

    await buttons[0]!.trigger("click");
    expect(heading(view)).toBe("Sign in or sign up");
    expect((view.get('input[type="email"]').element as HTMLInputElement).value).toBe("a@example.com");
  });
});

// EACH FAILURE SAYS ITS OWN REMEDY, in one line under the field. They were one line,
// "Check the address and try again", for failures that are never the address, and a
// mistyped address was told to check its email: the endpoint answers it with the same
// ok as a good one, so only the form can say.
describe("when a link can't be sent", () => {
  async function tried(address: string) {
    const view = await signedOut(false);
    await view.get('input[type="email"]').setValue(address);
    await view.get("form").trigger("submit");
    await flushPromises();
    return view;
  }
  const line = (view: Awaited<ReturnType<typeof tried>>) => view.get('.acct__signup [role="alert"]');

  it.each(["sam@gmail", "sam.example.com", "sam @example.com"])(
    "says %s isn't an address, and asks the server nothing",
    async (address) => {
      const view = await tried(address);
      expect(line(view).text()).toBe("Enter a valid email address.");
      expect(asked).toBe(0);
      expect(words(view)).not.toContain("We sent a sign-in link");
      const field = view.get('input[type="email"]');
      expect(field.attributes("aria-invalid")).toBe("true");
      expect(field.attributes("aria-describedby")).toBe(line(view).attributes("id"));
    },
  );

  it("leaves the browser's own bubble out of it", async () => {
    const view = await signedOut(false);
    expect(view.get("form").attributes("novalidate")).toBeDefined();
  });

  it.each([
    [429, "Too many tries. Wait a minute, then try again."],
    [503, "Sign-in links aren’t set up on this site yet."],
    [500, "Couldn’t send the link. Try again."],
  ])("says what a %i means, and never blames the address", async (status, words_) => {
    refuse = status;
    const view = await tried("a@example.com");
    expect(line(view).text()).toBe(words_);
    expect(view.get('input[type="email"]').attributes("aria-invalid")).toBeUndefined();
    expect(view.find("form").exists()).toBe(true);
  });

  it("puts the line under the field and above Continue", async () => {
    const view = await tried("sam@gmail");
    const order = [...view.get(".acct__signup").element.children].map((el) => el.tagName);
    expect(order).toEqual(["INPUT", "P", "BUTTON"]);
  });

  // The line was plain ink under the field, one more line of the form's own copy. It is
  // a red callout whose point touches the field, the one place besides destruction the
  // chrome spends colour, and on screen only while something has just gone wrong.
  it("says it in the red callout that points at the field", async () => {
    const view = await tried("sam@gmail");
    expect(line(view).classes()).toContain("errtip");
    const css = readFileSync(resolve(__dirname, "../app/assets/styles/atoms/controls.scss"), "utf8");
    const at = css.indexOf("\n.errtip {");
    const bubble = css.slice(at, css.indexOf("}", at));
    expect(bubble).toContain("background: var(--danger-solid)");
    expect(bubble).toContain("color: var(--danger-foreground)");
    expect(css).toContain(".errtip::before {");
    // white on the light theme's red in BOTH themes: on dark's lighter red it is 4.0:1
    const tokens = readFileSync(resolve(__dirname, "../app/assets/styles/foundations/tokens.scss"), "utf8");
    expect(tokens).toContain("--danger-solid: oklch(0.55 0.22 25);");
  });

  it("makes the callout afresh on a second failed press, so the press is seen to land", async () => {
    const view = await tried("sam@gmail");
    const first = line(view).element;
    await view.get("form").trigger("submit");
    await flushPromises();
    expect(line(view).element).not.toBe(first);
    expect(line(view).text()).toBe("Enter a valid email address.");
  });

  // A struck spring: it swings either side of rest, each return smaller than the last,
  // and ends where it began. In the dialog it is the whole card that shakes
  // (accountModal); mounted bare, as it is as a step of another page, there is no card
  // and the field shakes.
  it("shakes for an address that isn't one, and again on a second press", async () => {
    const view = await tried("sam@gmail");
    const field = view.get('input[type="email"]');
    expect(field.classes()).toContain("is-shaking");
    await field.trigger("animationend");
    expect(field.classes()).not.toContain("is-shaking");
    await view.get("form").trigger("submit");
    expect(field.classes()).toContain("is-shaking");
  });

  it("shakes as one spring, not as separate legs that each stop", () => {
    const css = readFileSync(resolve(__dirname, "../app/assets/styles/main.scss"), "utf8");
    expect(css).toContain("animation: shake-x var(--spring-shake-dur) var(--spring-shake);");
    const tokens = readFileSync(resolve(__dirname, "../app/assets/styles/foundations/tokens.scss"), "utf8");
    const curve = /--spring-shake: linear\(([^)]*)\)/.exec(tokens)![1]!.split(",").map(Number);
    // starts and ends at rest, and crosses it on the way: both sides, shrinking
    expect(curve[0]).toBe(0);
    expect(curve.at(-1)).toBe(0);
    const max = Math.max(...curve);
    const min = Math.min(...curve);
    expect(max).toBeGreaterThan(0.95);
    expect(min).toBeLessThan(-0.4);
    expect(Math.abs(min)).toBeLessThan(max);
    // smooth: no sample jumps more than half the reach from the one before
    for (let i = 1; i < curve.length; i++) expect(Math.abs(curve[i]! - curve[i - 1]!)).toBeLessThan(0.5);
  });

  it("does not shake for a failure that isn't about the address", async () => {
    refuse = 429;
    const view = await tried("a@example.com");
    expect(view.get('input[type="email"]').classes()).not.toContain("is-shaking");
  });

  it("takes the line away once the address is retyped", async () => {
    const view = await tried("sam@gmail");
    await view.get('input[type="email"]').setValue("sam@gmail.com");
    expect(view.find('[role="alert"]').exists()).toBe(false);
    expect(view.get('input[type="email"]').attributes("aria-invalid")).toBeUndefined();
  });
});

// The form's field or button had focus when the form was swapped out, and focus fell to
// <body>: the next Tab landed on the page behind the dialog, outside its trap.
describe("focus, as the form steps aside and comes back", () => {
  it("goes to the sent line, then back to the field", async () => {
    const view = await signedOut(false);
    await view.get('input[type="email"]').setValue("a@example.com");
    await view.get("form").trigger("submit");
    await flushPromises();
    expect(document.activeElement).toBe(view.get(".acct__sent").element);

    await view.get(".acct__again").trigger("click");
    await flushPromises();
    expect(document.activeElement).toBe(view.get('input[type="email"]').element);
  });
});
