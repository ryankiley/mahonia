// Assistant access is folded under Connect: the client buttons and the token form wait
// until asked for, but what is already connected stays listed, since reviewing and
// disconnecting it is what most people come to the section for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import AccountView from "~/components/AccountView.vue";
import type { AccessTokenSummary } from "~~/shared/types";

enableAutoUnmount(afterEach);

const claude: AccessTokenSummary = {
  id: 1,
  kind: "app",
  label: "Claude",
  scope: "write",
  createdAt: "2026-11-01T00:00:00Z",
  lastUsedAt: null,
};
registerEndpoint("/api/account/tokens", () => ({ tokens: [claude] }));

beforeEach(() => {
  useState("session").value = {
    state: "signedIn",
    user: { owner: "1", email: "a@example.com", displayName: null, sweep: true, account: "a" },
  };
});

type Mounted = ReturnType<typeof mount>;
const connect = (w: Mounted) => w.findAll("button").find((b) => b.text() === "Connect")!;
const addToClaude = (w: Mounted) => w.findAll("a").find((a) => a.text() === "Add to Claude");
/** mounted, with the connections read */
async function mounted() {
  const view = mount(AccountView, { attachTo: document.body });
  await vi.waitFor(() => expect(view.find(".acct__item").exists()).toBe(true));
  return view;
}

describe("assistant access", () => {
  it("starts folded, with what is connected still listed", async () => {
    const view = await mounted();

    expect(connect(view).attributes("aria-expanded")).toBe("false");
    expect(addToClaude(view)).toBeUndefined();
    expect(view.findAll("button").some((b) => b.text() === "Make an access token")).toBe(false);
    expect(view.get(".acct__item .acct__name").text()).toBe("Claude");
    expect(view.findAll("button").some((b) => b.text() === "Disconnect")).toBe(true);
  });

  it("opens the client buttons and the token link under Connect, and folds them again", async () => {
    const view = await mounted();

    await connect(view).trigger("click");
    expect(connect(view).attributes("aria-expanded")).toBe("true");
    expect(addToClaude(view)).toBeDefined();
    expect(view.findAll("button").some((b) => b.text() === "Make an access token")).toBe(true);
    // the button names what it opens, and only while it is there to name
    expect(document.getElementById(connect(view).attributes("aria-controls")!)).not.toBeNull();

    await connect(view).trigger("click");
    await flushPromises();
    expect(connect(view).attributes("aria-expanded")).toBe("false");
    expect(connect(view).attributes("aria-controls")).toBeUndefined();
    expect(view.get(".acct__item .acct__name").text()).toBe("Claude");
  });
});
