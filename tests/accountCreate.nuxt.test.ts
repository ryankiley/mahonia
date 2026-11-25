// The Create an account form. Its own comment said it "owes a reason for asking" for
// an address and the form gave none; and in a browser that can't make a passkey its
// one button was disabled with no word why, or of the way that does work.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import AccountView from "~/components/AccountView.vue";

const { supported } = vi.hoisted(() => ({ supported: { value: true } }));
mockNuxtImport("passkeysSupported", () => () => supported.value);

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.cookie = "mh_signed_in=; Max-Age=0; path=/";
  useState("session").value = { state: "signedOut" };
});

async function createForm(canPasskey: boolean) {
  supported.value = canPasskey;
  const view = mount(AccountView, { props: { inModal: true }, attachTo: document.body });
  await flushPromises();
  await nextTick();
  await view.get(".acct__switch").trigger("click");
  await nextTick();
  return view;
}

describe("the Create an account form", () => {
  it("says why it asks for an email", async () => {
    const view = await createForm(true);
    expect(view.get(".acct__why").text()).toBe("Your email is how you get back in if you lose your devices.");
    expect(view.find(".acct__note").exists()).toBe(false);
  });

  it("says so where the browser can't make a passkey, and hands the address to the sign-in link", async () => {
    const view = await createForm(false);
    expect(view.get('button[type="submit"]').attributes("disabled")).toBeDefined();
    const note = view.get(".acct__note");
    expect(note.text().replace(/\s+/g, " ")).toBe(
      "This browser can’t make a passkey. Use a sign-in link instead, which makes an account for a new address.",
    );

    await view.get('input[type="email"]').setValue("new@example.com");
    await note.get("button").trigger("click");
    await nextTick();
    expect(view.get('button[type="submit"]').text()).toBe("Email me a link");
    expect(view.get<HTMLInputElement>('input[type="email"]').element.value).toBe("new@example.com");
  });
});
