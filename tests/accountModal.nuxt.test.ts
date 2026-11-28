// The account dialog's title, and which of its two shapes it is drawn in. It names itself
// by the panel inside: Sign in or sign up for someone signed out, whether they are new or
// returning (there is one form, see accountOneDoor), and Your account once there is one.
// Signed out it is the sign-in card (the mark, a centred title, no close button to see);
// signed in it is a title bar with its X over sections.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { mountSuspended } from "@nuxt/test-utils/runtime";
import AccountModal from "~/components/AccountModal.vue";
import AppOverlays from "~/components/AppOverlays.vue";
import ErrorPage from "~/error.vue";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.cookie = "mh_signed_in=; Max-Age=0; path=/";
  useState("session").value = { state: "signedOut" };
  useAccountModal().open();
});
afterEach(() => useAccountModal().close());

async function open() {
  const dialog = mount(AccountModal, { attachTo: document.body });
  await flushPromises();
  await nextTick();
  return dialog;
}
const title = (w: Awaited<ReturnType<typeof open>>) => w.get("h2").text();
const name = (w: Awaited<ReturnType<typeof open>>) => w.get('[role="dialog"]').attributes("aria-label");

describe("the account dialog's title", () => {
  it("opens as Sign in or sign up for someone signed out", async () => {
    const w = await open();
    expect(title(w)).toBe("Sign in or sign up");
    expect(name(w)).toBe("Sign in or sign up");
  });

  it("is Your account once there is one", async () => {
    useState("session").value = {
      state: "signedIn",
      user: { owner: "1", email: "a@example.com", displayName: null, sweep: true, account: "a" },
    };
    const w = await open();
    expect(title(w)).toBe("Your account");
    expect(name(w)).toBe("Your account");
  });
});

describe("the account dialog's two shapes", () => {
  it("is the sign-in card for someone signed out: the mark over a centred title", async () => {
    const w = await open();
    expect(w.find(".signin__head svg.signin__mark").exists()).toBe(true);
    expect(w.get(".signin__head h2").classes()).toContain("signin__title");
    expect(w.find(".panel__head").exists()).toBe(false);
  });

  it("keeps a close button there for the keyboard and a screen reader, after the form", async () => {
    const w = await open();
    const buttons = w.findAll('[role="dialog"] button');
    const close = buttons[buttons.length - 1]!;
    expect(close.attributes("aria-label")).toBe("Close");
    expect(close.classes()).toContain("signin__close");
    await close.trigger("click");
    expect(useAccountModal().state.open).toBe(false);
  });

  it("is a title bar with its X once there is an account", async () => {
    useState("session").value = {
      state: "signedIn",
      user: { owner: "1", email: "a@example.com", displayName: null, sweep: true, account: "a" },
    };
    const w = await open();
    expect(w.find(".signin__head").exists()).toBe(false);
    expect(w.get(".panel__head button").attributes("aria-label")).toBe("Close your account");
  });
});

describe("opened from a sign-in link that has expired", () => {
  it("is titled for what happened, over the form that sends a new one", async () => {
    useAccountModal().open("expired");
    const w = await open();
    expect(title(w)).toBe("That link has expired");
    expect(name(w)).toBe("That link has expired");
    expect(w.text()).toContain("Sign-in links work once and last 15 minutes. Enter your email for a new one.");
    expect(w.text()).not.toContain("An account saves your gear");
    expect(w.find('input[type="email"]').exists()).toBe(true);
  });

  it("is titled for a link that would not sign in, the same way", async () => {
    useAccountModal().open("failed");
    const w = await open();
    expect(title(w)).toBe("Couldn’t sign you in");
    expect(w.text()).toContain("That link isn’t working. Enter your email for a new one.");
    expect(w.find('input[type="email"]').exists()).toBe(true);
  });

  it("forgets the reason on the next open, and never takes a click's event for one", async () => {
    useAccountModal().open("expired");
    useAccountModal().close();
    useAccountModal().open(new MouseEvent("click"));
    expect(useAccountModal().state.notice).toBeNull();
    const w = await open();
    expect(title(w)).toBe("Sign in or sign up");
  });
});

// A bad address shakes the card as one object. The field alone, swinging inside a card
// that stayed still, read as a twitch.
// One field and Continue: under a pointer that can hover the field has the caret as the
// card opens. On touch it does not, because focus there raises the keyboard over the card.
describe("where the sign-in card opens", () => {
  const pointer = (fine: boolean) =>
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: fine && q === "(hover: hover) and (pointer: fine)", media: q }) as MediaQueryList);
  afterEach(() => vi.unstubAllGlobals());

  it("puts the caret in the address field for a mouse", async () => {
    pointer(true);
    const w = await open();
    expect(document.activeElement).toBe(w.get('input[type="email"]').element);
  });

  it("leaves the field alone on touch, with focus on the card", async () => {
    pointer(false);
    const w = await open();
    expect(document.activeElement).toBe(w.get('[role="dialog"]').element);
  });
});

describe("a bad address in the sign-in card", () => {
  it("shakes the whole card, not the field inside it", async () => {
    const w = await open();
    await w.get('input[type="email"]').setValue("sam@gmail");
    await w.get("form").trigger("submit");
    const card = w.get('[role="dialog"]');
    expect(card.classes()).toContain("is-shaking");
    expect(w.get('input[type="email"]').classes()).not.toContain("is-shaking");

    await card.trigger("animationend");
    expect(card.classes()).not.toContain("is-shaking");
    await w.get("form").trigger("submit");
    expect(card.classes()).toContain("is-shaking");
  });
});


// The overlays app.vue and the error page both mount, in one order: a confirm raised
// from inside the account dialog (delete-account is) has to paint over it, and every
// overlay shares one z-index, so the later mount is the one on top.
describe("among the app's overlays", () => {
  const dialogs = () => [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute("aria-label"));

  it("puts a confirm raised over the account dialog on top of it", async () => {
    mount(AppOverlays, { attachTo: document.body });
    await vi.waitFor(() => expect(dialogs()).toEqual(["Sign in or sign up"]));
    void useDialogs().confirm({ title: "Delete your account?", message: "Gone for good.", confirmLabel: "Delete" });
    await vi.waitFor(() => expect(dialogs()).toEqual(["Sign in or sign up", "Delete your account?"]));
    useDialogs().settleConfirm(false);
  });

  it("opens the feedback box over the error page too", async () => {
    useAccountModal().close();
    onTestFinished(() => useFeedback().close());
    const page = await mountSuspended(ErrorPage, { props: { error: createError({ statusCode: 404 }) }, attachTo: document.body });
    useFeedback().open();
    await vi.waitFor(() => expect(page.find('[role="dialog"] textarea').exists()).toBe(true));
  });
});
