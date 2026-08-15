// @vitest-environment nuxt
//
// The Sharing panel's "Your account" section — the explicit way a list this
// browser holds gets attached to the signed-in account.
//
// The automatic sweep deliberately skips rows marked "opened" (a list someone
// shared with you must never ride into an account as a side effect), which
// leaves your own list, held here through its edit link, with no path onto the
// account at all — the second device then never shows it. This section is that
// path, so what's under test is when it renders, what it claims, and that it
// flips to the quiet confirmation the moment the claim lands.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { flushPromises, mount } from "@vue/test-utils";
import SharePanel from "~/components/SharePanel.vue";
import type { ListSnapshot } from "~~/shared/types";
import type { ClaimedList } from "~/composables/useClaimedLists";

// the panel's activity fetch on mount — not under test, kept quiet
vi.stubGlobal(
  "$fetch",
  vi.fn(() => Promise.resolve({ snapshots: [] })),
);

const signedIn = ref(true);
mockNuxtImport("useSession", () => () => ({ signedIn }));

const claimedLists = ref<ClaimedList[]>([]);
const claimedLoaded = ref(true);
const claimOne = vi.fn(async (_token: string) => true);
const refresh = vi.fn(async () => {});
mockNuxtImport("useClaimedLists", () => () => ({
  lists: claimedLists,
  loaded: claimedLoaded,
  claimOne,
  refresh,
}));

const SHARE = "LOOWIT000001";
const snapshot = {
  shareCode: SHARE,
  slug: "loowit-aa11bb",
  title: "Loowit Traverse",
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version: 3,
  isPublic: false,
} as unknown as ListSnapshot;

const claimedRow = (shareCode: string): ClaimedList => ({
  shareCode,
  slug: "loowit-aa11bb",
  title: "Loowit Traverse",
  totalMg: 0,
  version: 3,
  displayUnit: "g",
  updatedAt: new Date(0).toISOString(),
});

function mountPanel(over: { editToken?: string } = {}) {
  return mount(SharePanel, {
    props: {
      snapshot,
      editToken: over.editToken ?? "held-token",
      authHeaders: { Authorization: "Bearer held-token" },
      readUrl: `https://x/s/${SHARE}`,
      editUrl: `https://x/e/${SHARE}#held-token`,
    },
    attachTo: document.body,
  });
}

const section = (w: ReturnType<typeof mountPanel>) =>
  w
    .findAll(".share__field")
    .find((s) => s.find(".share__subtitle").text().includes("account"));

beforeEach(() => {
  signedIn.value = true;
  claimedLists.value = [];
  claimedLoaded.value = true;
  claimOne.mockClear();
  refresh.mockClear();
});

describe("SharePanel — the account section", () => {
  it("offers Add to your account for a held, unclaimed list", () => {
    const w = mountPanel();
    const s = section(w);
    expect(s).toBeTruthy();
    expect(s!.text()).toContain("On this device only");
    expect(s!.find(".share__claim").exists()).toBe(true);
  });

  it("claims with THIS list's edit token, then reads back as on the account", async () => {
    claimOne.mockImplementation(async () => {
      claimedLists.value = [claimedRow(SHARE)]; // what the real claimOne does: adopt the server's set
      return true;
    });
    const w = mountPanel();
    await section(w)!.find(".share__claim").trigger("click");
    await flushPromises();

    expect(claimOne).toHaveBeenCalledWith("held-token");
    const s = section(w)!;
    expect(s.text()).toContain("On your account");
    expect(s.find(".share__claim").exists()).toBe(false);
  });

  it("says so, with no button, when the list is already on the account", () => {
    claimedLists.value = [claimedRow(SHARE)];
    const w = mountPanel();
    const s = section(w)!;
    expect(s.text()).toContain("On your account");
    expect(s.find(".share__claim").exists()).toBe(false);
  });

  it("renders nothing signed out — the panel doesn't sell accounts", () => {
    signedIn.value = false;
    expect(section(mountPanel())).toBeUndefined();
  });

  it("renders nothing on a claimed open — the edit-link section already says it", () => {
    // no token held: the claimed-open case, where the capability is the session
    expect(section(mountPanel({ editToken: "" }))).toBeUndefined();
  });

  it("waits for the claim set before deciding — no Add flash on a claimed list", () => {
    claimedLoaded.value = false;
    expect(section(mountPanel())).toBeUndefined();
  });

  it("keeps the offer up and says so when the claim doesn't land", async () => {
    claimOne.mockImplementation(async () => false);
    const w = mountPanel();
    await section(w)!.find(".share__claim").trigger("click");
    await flushPromises();

    const s = section(w)!;
    expect(s.find(".share__claim").exists()).toBe(true);
    expect(s.text()).toContain("try again");
  });

  it("fetches the claim set on open, so a straight-from-link open still knows", () => {
    mountPanel();
    expect(refresh).toHaveBeenCalled();
  });
});
