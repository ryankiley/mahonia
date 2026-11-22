// The account dialog's title. The dialog draws its own title row (it carries the close
// button), and the panel inside owns the switch between signing in and creating an
// account, so the title has to follow the panel: it read "Sign in" over the create form,
// where /account's own heading said "Create an account".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import AccountModal from "~/components/AccountModal.vue";

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
const title = (w: Awaited<ReturnType<typeof open>>) => w.get("h2.panel__title").text();
const name = (w: Awaited<ReturnType<typeof open>>) => w.get('[role="dialog"]').attributes("aria-label");

describe("the account dialog's title", () => {
  it("opens as Sign in for someone signed out", async () => {
    const w = await open();
    expect(title(w)).toBe("Sign in");
    expect(name(w)).toBe("Sign in");
  });

  it("follows the panel to Create an account and back, and names the dialog the same", async () => {
    const w = await open();
    await w.get(".acct__switch").trigger("click");
    await nextTick();
    expect(title(w)).toBe("Create an account");
    expect(name(w)).toBe("Create an account");

    await w.get(".acct__switch").trigger("click");
    await nextTick();
    expect(title(w)).toBe("Sign in");
    expect(name(w)).toBe("Sign in");
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
