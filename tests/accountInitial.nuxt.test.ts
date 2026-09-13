// @vitest-environment nuxt
//
// The letter on the account disc: where it comes from, and how it is already on the
// disc when the bar mounts.
//
// Two things are pinned. The LETTER: the display name's first grapheme, the address's
// when there is no name — never a code unit or code point, because a trail name can
// open with a flag or a joined emoji and a pasted name can carry its accent as a
// separate mark. And the MEMO: the session plugin never waits for /api/auth/me, so on
// every load the control mounts before it knows who is signed in; the disc reads this
// device's memo of the letter until then, every resolved session rewrites it, and the
// way out of an account (forgetAccountMemos) drops it with the other per-account memos.
import { beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { flushPromises, mount } from "@vue/test-utils";
import { stubLocalStorage } from "./helpers/storage";
import { accountInitial, forgetAccountInitial, useAccountInitial } from "~/composables/useAccountInitial";
import AccountMenu from "~/components/AccountMenu.vue";

const KEY = "gear.account.initial.v1";
const storage = stubLocalStorage();

// the session as AccountMenu and the composable read it: a user that starts
// unresolved and a presence that says an account is behind this browser
const user = ref<{ email: string | null; displayName: string | null } | null>(null);
const presence = ref<"signedIn" | "signedOut" | "presumed">("presumed");
mockNuxtImport("useSession", () => () => ({ user, presence, signOut: async () => {} }));

beforeEach(() => {
  storage.clear();
  user.value = null;
  presence.value = "presumed";
});

describe("accountInitial — the one character the disc wears", () => {
  it("is the first letter of the display name", () => {
    expect(accountInitial({ displayName: "Ryan Kiley", email: "ryan@example.com" })).toBe("R");
  });

  it("falls back to the address when there is no name", () => {
    expect(accountInitial({ displayName: null, email: "ryan@example.com" })).toBe("r");
    // an empty name is no name — the server stores a cleared field as null, but
    // the fallback holds for "" and whitespace too
    expect(accountInitial({ displayName: "   ", email: "ryan@example.com" })).toBe("r");
  });

  it("leaves case to the stylesheet", () => {
    expect(accountInitial({ displayName: "dirtbag", email: null })).toBe("d");
  });

  it("takes a whole grapheme, not the first code unit or code point", () => {
    // a flag is two regional indicators; [0] would be half of one
    expect(accountInitial({ displayName: "🇺🇸 Trail", email: null })).toBe("🇺🇸");
    // a joined emoji is several code points behind zero-width joiners
    expect(accountInitial({ displayName: "👩‍👩‍👧 fam", email: null })).toBe("👩‍👩‍👧");
    // a decomposed "é" is an "e" followed by its combining mark; the mark stays
    expect(accountInitial({ displayName: "élodie", email: null })).toBe("é");
  });

  it("is empty only when there is nothing at all to draw from", () => {
    expect(accountInitial({ displayName: null, email: null })).toBe("");
  });
});

describe("useAccountInitial — the memo that letters the disc at first paint", () => {
  it("reads this device's memo while the session is unresolved", async () => {
    storage.set(KEY, "R");
    const initial = mount({
      setup: () => ({ initial: useAccountInitial() }),
      template: "<i>{{ initial }}</i>",
    });
    await flushPromises();
    expect(initial.text()).toBe("R");
  });

  it("is empty on a browser with neither a session nor a memo", async () => {
    const initial = mount({
      setup: () => ({ initial: useAccountInitial() }),
      template: "<i>{{ initial }}</i>",
    });
    await flushPromises();
    expect(initial.text()).toBe("");
    expect(storage.has(KEY)).toBe(false); // nothing to remember yet, nothing written
  });

  it("follows the resolved session and rewrites the memo — a name changed elsewhere reaches this disc", async () => {
    storage.set(KEY, "R");
    const initial = mount({
      setup: () => ({ initial: useAccountInitial() }),
      template: "<i>{{ initial }}</i>",
    });
    user.value = { email: "ryan@example.com", displayName: "Kestrel" };
    await flushPromises();
    expect(initial.text()).toBe("K");
    expect(storage.get(KEY)).toBe("K");
  });

  it("remembers the letter of a session that has already resolved when it mounts", async () => {
    user.value = { email: "ryan@example.com", displayName: null };
    mount({
      setup: () => ({ initial: useAccountInitial() }),
      template: "<i>{{ initial }}</i>",
    });
    await flushPromises();
    expect(storage.get(KEY)).toBe("r");
  });

  it("forgets the memo on the way out of an account", () => {
    storage.set(KEY, "R");
    forgetAccountInitial();
    expect(storage.has(KEY)).toBe(false);
  });
});

describe("AccountMenu — the signed-in trigger wears the letter", () => {
  it("mounts lettered from the memo, keeps its accessible name, and hides the letter from it", async () => {
    storage.set(KEY, "R");
    const wrapper = mount(AccountMenu, { attachTo: document.body });
    await flushPromises();
    const trigger = wrapper.get("button.menu__btn");
    expect(trigger.attributes("aria-label")).toBe("Your account");
    const disc = trigger.get(".avatar");
    expect(disc.text()).toBe("R");
    expect(disc.attributes("aria-hidden")).toBe("true");
    // the person glyph is gone — the disc is the whole mark
    expect(trigger.find("svg").exists()).toBe(false);
    wrapper.unmount();
  });

  it("updates the letter when the session resolves with a different name", async () => {
    storage.set(KEY, "R");
    const wrapper = mount(AccountMenu, { attachTo: document.body });
    await flushPromises();
    user.value = { email: "ryan@example.com", displayName: "Kestrel" };
    presence.value = "signedIn";
    await flushPromises();
    expect(wrapper.get(".avatar").text()).toBe("K");
    wrapper.unmount();
  });
});
