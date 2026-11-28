// OFFLINE IS SAID BEFORE ANYONE PRESSES. The bar's account control turns into a cloud with
// a line through it, the status line beside it drops the word the glyph now carries (it
// read "Offline · saved on device" and a phone cut it off mid-word), and the sign-in form
// holds Continue with a note instead of letting the press fail.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { stubLocalStorage } from "./helpers/storage";
import type { Presence } from "~/composables/useSession";
import { IconCloudOff, IconUserKey } from "~/icons/central";
import AccountMenu from "~/components/AccountMenu.vue";
import AccountView from "~/components/AccountView.vue";
import SyncStatus from "~/components/SyncStatus.vue";

stubLocalStorage();
enableAutoUnmount(afterEach);

// The account card is AccountMenuCard, mounted Lazy on the first open: wait for it.
async function cardLoaded() {
  await vi.dynamicImportSettled();
  await flushPromises();
}

const presence = ref<Presence>("signedOut");
const user = ref<{ email: string | null; displayName: string | null } | null>(null);
mockNuxtImport("useSession", () => () => ({
  user,
  presence,
  signedIn: computed(() => presence.value === "signedIn"),
  loaded: ref(true),
  pending: ref(false),
  refresh: async () => {},
  requestLink: async () => "sent" as const,
  signOut: async () => {},
  saveProfile: async () => true,
  forgetAccountMemos: () => {},
}));
mockNuxtImport("passkeysSupported", () => () => false);

// the open list, as the status line reads it
const status = ref("synced");
const snapshot = ref<{ updatedAt?: string; folders: unknown[] } | null>(null);
mockNuxtImport("useGearList", () => () => ({ status, snapshot }));

let online: ReturnType<typeof vi.spyOn>;
const goOffline = () => {
  online.mockReturnValue(false);
  window.dispatchEvent(new Event("offline"));
};
const goOnline = () => {
  online.mockReturnValue(true);
  window.dispatchEvent(new Event("online"));
};
beforeEach(() => {
  online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  presence.value = "signedOut";
  useSyncOffline().value = null;
});
afterEach(() => online.mockRestore());

/** the path data of the glyph a control draws */
const drawn = (el: Element) => el.querySelector("svg path")?.getAttribute("d");
const pathOf = (icon: typeof IconCloudOff) => (icon[0]![1] as { d: string }).d;

describe("the bar's account control, offline", () => {
  async function bar() {
    const w = mount(AccountMenu, { props: { compact: true }, attachTo: document.body });
    await flushPromises();
    return w;
  }

  it("is the sign-in button with a connection, and a struck cloud without one", async () => {
    const w = await bar();
    expect(drawn(w.get("button.acct__signinbtn").element)).toBe(pathOf(IconUserKey));

    goOffline();
    await nextTick();
    expect(w.find("button.acct__signinbtn").exists()).toBe(false);
    const cloud = w.get("button.menu__btn");
    expect(drawn(cloud.element)).toBe(pathOf(IconCloudOff));
    expect(cloud.attributes("aria-label")).toBe("You’re offline");

    goOnline();
    await nextTick();
    expect(drawn(w.get("button.acct__signinbtn").element)).toBe(pathOf(IconUserKey));
  });

  // Pressed, it says the state in full where it was pressed. It does not open the
  // sign-in dialog: offline, that was a form that could only say no.
  it("says you're offline when pressed, and that signing in will wait", async () => {
    goOffline();
    const w = await bar();
    await w.get("button.menu__btn").trigger("click");
    await cardLoaded();
    const card = w.get(".acct__offline");
    expect(card.get(".acct__offhead").text()).toBe("You’re offline");
    expect(card.get(".acct__offline-line").text()).toBe("Sign in when you’re back online.");
    expect(useAccountModal().state.open).toBe(false);
    // nothing to press in it for someone signed out
    expect(w.findAll('[role="menuitem"]')).toHaveLength(0);
  });

  it("says the open list is saved on this device, which the status line used to", async () => {
    goOffline();
    useSyncOffline().value = "saved";
    const w = await bar();
    await w.get("button.menu__btn").trigger("click");
    await cardLoaded();
    expect(w.get(".acct__offline-line").text()).toBe(
      "This list is saved on this device. Sign in when you’re back online.",
    );
  });

  // Two kinds of offline. The list's sync also says so when the browser has a connection
  // and the server did not answer for the list, and then signing in may well work: the
  // card says what is known and keeps the way in.
  it("takes the list's word for it too, and then says Mahonia can't be reached", async () => {
    const w = await bar();
    useSyncOffline().value = "saved";
    await nextTick();
    const cloud = w.get("button.menu__btn");
    expect(drawn(cloud.element)).toBe(pathOf(IconCloudOff));
    expect(cloud.attributes("aria-label")).toBe("Can’t reach Mahonia");

    await cloud.trigger("click");
    await cardLoaded();
    expect(w.get(".acct__offhead").text()).toBe("Can’t reach Mahonia");
    expect(w.get(".acct__offline-line").text()).toBe("This list is saved on this device.");
    const rows = w.findAll('[role="menuitem"]');
    expect(rows.map((r) => r.text())).toEqual(["Sign in"]);
    await rows[0]!.trigger("click");
    expect(useAccountModal().state.open).toBe(true);
    useAccountModal().close();
  });

  it("closes the card and is a button again when the connection is back", async () => {
    goOffline();
    const w = await bar();
    await w.get("button.menu__btn").trigger("click");
    await cardLoaded();
    goOnline();
    await nextTick();
    expect(w.find(".acct__offline").exists()).toBe(false);
    expect(w.find("button.acct__signinbtn").exists()).toBe(true);
  });

  it("replaces the lettered disc the same way, and offers nothing that needs the server", async () => {
    presence.value = "signedIn";
    user.value = { email: "ryan@example.com", displayName: null };
    goOffline();
    useSyncOffline().value = "saved";
    const w = await bar();
    const trigger = w.get("button.menu__btn");
    expect(w.find(".avatar").exists()).toBe(false);
    expect(drawn(trigger.element)).toBe(pathOf(IconCloudOff));
    expect(trigger.attributes("aria-label")).toBe("Your account. You’re offline.");
    await trigger.trigger("click");
    await cardLoaded();
    expect(w.get(".acct__offline-line").text()).toBe(
      "This list is saved on this device. It syncs when you’re back online.",
    );
    // no connection: the account dialog could only say so, and a sign-out could not
    // reach the server, so neither row is offered
    const rows = w.findAll('[role="menuitem"]').map((r) => r.text());
    expect(rows).not.toContain("Your account");
    expect(rows).not.toContain("Sign out");
  });

  it("keeps the account's rows when it is only Mahonia that can't be reached", async () => {
    presence.value = "signedIn";
    user.value = { email: "ryan@example.com", displayName: null };
    const w = await bar();
    useSyncOffline().value = "saved";
    await nextTick();
    await w.get("button.menu__btn").trigger("click");
    await cardLoaded();
    expect(w.get(".acct__offhead").text()).toBe("Can’t reach Mahonia");
    expect(w.findAll('[role="menuitem"]').map((r) => r.text())).toEqual(
      expect.arrayContaining(["Your account", "Sign out"]),
    );
  });
});

describe("the sign-in form, offline", () => {
  async function form() {
    const w = mount(AccountView, { attachTo: document.body });
    await flushPromises();
    await nextTick();
    return w;
  }

  it("says so and holds Continue, before anything is pressed", async () => {
    goOffline();
    const w = await form();
    await w.get('input[type="email"]').setValue("a@example.com");
    const note = w.get(".acct__signup .errtip");
    expect(note.text()).toBe("You’re offline. Connect to sign in.");
    // a note, in ink: nothing has gone wrong yet, so it is not the red of an error
    expect(note.classes()).toContain("errtip--note");
    expect(note.attributes("role")).toBe("status");
    expect(w.get(".acct__signup button").attributes("disabled")).toBeDefined();
  });

  it("lets go by itself when the connection is back", async () => {
    goOffline();
    const w = await form();
    await w.get('input[type="email"]').setValue("a@example.com");
    goOnline();
    await nextTick();
    expect(w.find(".acct__signup .errtip").exists()).toBe(false);
    expect(w.get(".acct__signup button").attributes("disabled")).toBeUndefined();
  });
});

describe("the status line, offline", () => {
  beforeEach(() => {
    status.value = "offline";
    // a list the server has saved, so "synced" has a time to show and nothing to weigh
    snapshot.value = { updatedAt: new Date().toISOString(), folders: [] };
  });

  // It read "Offline · saved on device", and a phone cut that off mid-word. The glyph
  // beside it carries "offline" and says the rest when pressed.
  it("draws nothing, and still says it to a screen reader", async () => {
    const w = mount(SyncStatus, { attachTo: document.body });
    await nextTick();
    const line = w.get('[aria-live="polite"]');
    expect(line.get(".visually-hidden").text()).toBe("Offline. Saved on this device.");
    // everything in the line is the hidden span: nothing is left for the eye
    expect(line.text()).toBe("Offline. Saved on this device.");
    expect(line.element.childNodes.length).toBe(2); // the span and an empty text node
  });

  it("tells the account control what it knows, for as long as it is on screen", async () => {
    const w = mount(SyncStatus, { attachTo: document.body });
    await nextTick();
    expect(useSyncOffline().value).toBe("saved");
    snapshot.value = null;
    await nextTick();
    expect(useSyncOffline().value).toBe("unsaved");
    snapshot.value = { updatedAt: new Date().toISOString(), folders: [] };
    status.value = "synced";
    await nextTick();
    expect(useSyncOffline().value).toBeNull();
    status.value = "offline";
    await nextTick();
    w.unmount();
    expect(useSyncOffline().value).toBeNull();
  });
});
