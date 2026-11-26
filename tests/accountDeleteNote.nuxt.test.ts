// Deleting the account, as the person sees it end. The page flips to the sign-in screen
// once the session has gone, and that used to be the whole of it: the line saying the
// account was deleted was still built and timed, but the markup that drew it went when
// the account became a panel with two mounts (#174), so an irreversible thing finished
// with nothing on screen saying it had.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { readBody } from "h3";
import AccountModal from "~/components/AccountModal.vue";
import AccountView from "~/components/AccountView.vue";

enableAutoUnmount(afterEach);

// what the server says it deleted, and what it was asked to
let listsDeleted = 0;
let asked: { deleteLists?: boolean }[] = [];
registerEndpoint("/api/account/delete", {
  method: "POST",
  handler: async (event) => {
    asked.push(await readBody(event));
    return { ok: true, listsDeleted };
  },
});
registerEndpoint("/api/account/tokens", () => ({ tokens: [] }));

beforeEach(() => {
  listsDeleted = 0;
  asked = [];
  // no hint cookie: the re-read after the delete settles signed out without a request,
  // as it does once the server has dropped the session's cookies
  document.cookie = "mh_signed_in=; Max-Age=0; path=/";
  useState("session").value = {
    state: "signedIn",
    user: { owner: "1", email: "a@example.com", displayName: null, sweep: true, account: "a" },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  useAccountModal().close();
});

type Mounted = ReturnType<typeof mount>;
// the app's toast, inside a status region so it is announced
const note = (w: Mounted) => w.find('[role="status"] .toast');

/** Press Delete account and say yes to the dialog, with or without the lists. */
async function deleteAccount(w: Mounted, alsoLists = false) {
  await w.get(".acct__danger").trigger("click");
  await nextTick();
  const { confirmState, settleConfirm } = useDialogs();
  confirmState.checked = alsoLists;
  settleConfirm(true);
  await vi.waitFor(() => expect(w.find(".acct__empty").exists()).toBe(true));
}

describe("deleting the account", () => {
  it("says the account was deleted, on the sign-in screen it lands on", async () => {
    const view = mount(AccountView, { attachTo: document.body });
    await flushPromises();
    await deleteAccount(view);

    expect(asked).toEqual([{ deleteLists: false }]);
    expect(view.get(".acct__empty button").text()).toBe("Continue");
    expect(note(view).exists()).toBe(true);
    expect(note(view).text()).toBe("Account deleted. Your lists are untouched.");
  });

  it("counts the lists that went with it", async () => {
    listsDeleted = 2;
    const view = mount(AccountView, { attachTo: document.body });
    await flushPromises();
    await deleteAccount(view, true);

    expect(asked).toEqual([{ deleteLists: true }]);
    expect(note(view).text()).toBe("Account deleted, along with 2 lists.");
  });

  it("says one list as one", async () => {
    listsDeleted = 1;
    const view = mount(AccountView, { attachTo: document.body });
    await flushPromises();
    await deleteAccount(view, true);
    expect(note(view).text()).toBe("Account deleted, along with 1 list.");
  });

  it("holds the line for eight seconds, then takes it down", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const view = mount(AccountView, { attachTo: document.body });
    await flushPromises();
    await deleteAccount(view);
    expect(note(view).exists()).toBe(true);

    const held = timers.mock.calls.find(([, ms]) => ms === 8000);
    expect(held, "an 8 s timer behind the line").toBeDefined();
    (held![0] as () => void)();
    await nextTick();
    expect(note(view).exists()).toBe(false);
  });

  // The dialog mount: the panel is still there once the session has gone (the dialog
  // stays open, retitled), so the line is said inside it.
  it("says it in the account dialog too, which stays open as the sign-in card", async () => {
    useAccountModal().open();
    const dialog = mount(AccountModal, { attachTo: document.body });
    await flushPromises();
    await nextTick();
    await deleteAccount(dialog);

    // signed out it is the sign-in card, with its own title
    expect(dialog.get("h2").text()).toBe("Sign in or sign up");
    expect(dialog.get('[role="dialog"]').find('[role="status"] .toast').text()).toBe(
      "Account deleted. Your lists are untouched.",
    );
  });
});
