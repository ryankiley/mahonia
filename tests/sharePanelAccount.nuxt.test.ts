// @vitest-environment nuxt
//
// The Sharing panel's "Add to your account" — the one control that attaches a
// list this browser holds to the signed-in account.
//
// It is an ACTION and nothing else: no heading, no status line, no confirmation.
// A list already on the account says nothing at all here, because a list being
// safe is the app's premise and reassuring anyone about it invites the doubt.
// So most of what's under test is when the button is ABSENT — the same "inert
// controls are absent, not disabled" rule the row's Save-to-My-Gear follows.
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

// the button, found by its label — the class it shares with "Replace this link"
// is deliberate (same quiet voice) and so can't identify it
const addBtn = (w: ReturnType<typeof mountPanel>) =>
  w.findAll("button").find((b) => b.text().includes("Add to your account"));

beforeEach(() => {
  signedIn.value = true;
  claimedLists.value = [];
  claimedLoaded.value = true;
  claimOne.mockClear();
  refresh.mockClear();
});

describe("SharePanel — adding a list to your account", () => {
  it("offers the action for a held list the account doesn't have", () => {
    expect(addBtn(mountPanel())).toBeTruthy();
  });

  it("claims with THIS list's edit token, then the button simply leaves", async () => {
    claimOne.mockImplementation(async () => {
      claimedLists.value = [claimedRow(SHARE)]; // what the real claimOne does: adopt the server's set
      return true;
    });
    const w = mountPanel();
    await addBtn(w)!.trigger("click");
    await flushPromises();

    expect(claimOne).toHaveBeenCalledWith("held-token");
    expect(addBtn(w)).toBeUndefined();
  });

  it("says NOTHING when the list is already on the account", () => {
    claimedLists.value = [claimedRow(SHARE)];
    const w = mountPanel();

    expect(addBtn(w)).toBeUndefined();
    // and no status line took its place — the whole complaint was being told
    // that something is saved when there was never a reason to think otherwise
    expect(w.text()).not.toContain("On your account");
    expect(w.text()).not.toContain("account");
  });

  it("stays away signed out — the panel doesn't sell accounts", () => {
    signedIn.value = false;
    expect(addBtn(mountPanel())).toBeUndefined();
  });

  it("stays away on a claimed open — the edit-link line already says it", () => {
    // no token held: the claimed-open case, where the capability is the session
    expect(addBtn(mountPanel({ editToken: "" }))).toBeUndefined();
  });

  it("waits for the claim set before deciding — no flash on a claimed list", () => {
    claimedLoaded.value = false;
    expect(addBtn(mountPanel())).toBeUndefined();
  });

  it("keeps the offer up and says so when the claim doesn't land", async () => {
    claimOne.mockImplementation(async () => false);
    const w = mountPanel();
    await addBtn(w)!.trigger("click");
    await flushPromises();

    expect(addBtn(w)).toBeTruthy();
    expect(w.text()).toContain("try again");
  });

  it("fetches the claim set on open, so a straight-from-link open still knows", () => {
    mountPanel();
    expect(refresh).toHaveBeenCalled();
  });
});
