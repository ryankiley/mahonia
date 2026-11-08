// The sharing panel: its two tabs (Share, Export), "Add to your account" (the one
// control that attaches a list this browser holds to the signed-in account), and who
// its recent changes name.
//
// It is an ACTION and nothing else: no heading, no status line, no confirmation.
// A list already on the account says nothing at all here, because a list being
// safe is the app's premise and reassuring anyone about it invites the doubt.
// So most of what's under test is when the button is ABSENT — the same "inert
// controls are absent, not disabled" rule the row's Save-to-My-Gear follows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { flushPromises, mount } from "@vue/test-utils";
import SharePanel from "~/components/SharePanel.vue";
import type { ChangeAuthor, ClaimedList, SnapshotMeta } from "~~/shared/types";
import { snapshotFor } from "./helpers/list";

// the panel's activity fetch on mount — not under test, kept quiet. A registered
// route rather than a $fetch stub: under the Nuxt environment $fetch is already
// test-utils' own mock, which answers an unregistered path with a 404.
let snapshotsData: SnapshotMeta[] = [];
registerEndpoint("/api/edit/snapshots", () => ({ snapshots: snapshotsData }));

// The exporters themselves are useListExports' (and tests/exportEverything's); what is
// under test here is the panel around them. Each fake row reports through the toast
// the panel handed the composable, a tick later, as the real ones do once their chunk
// and the clipboard answer.
const warmExporters = vi.fn();
const ran: string[] = [];
mockNuxtImport("useListExports", () => (_snap: unknown, flash: (msg: string) => void) => ({
  warmExporters,
  exportItems: ["text", "markdown", "csv", "json"].map((key) => ({
    key,
    label: `Export ${key}`,
    format: key.toUpperCase(),
    hint: `${key} hint`,
    icon: [],
    run: async () => {
      ran.push(key);
      await Promise.resolve();
      flash(`${key} done`);
    },
  })),
}));

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
const snapshot = snapshotFor({ shareCode: SHARE, slug: "loowit-aa11bb", title: "Loowit Traverse", version: 3 });

const claimedRow = (shareCode: string): ClaimedList => ({
  shareCode,
  slug: "loowit-aa11bb",
  title: "Loowit Traverse",
  totalMg: 0,
  version: 3,
  displayUnit: "g",
  updatedAt: new Date(0).toISOString(),
});

const flash = vi.fn();

function mountPanel(over: { editToken?: string; shareCode?: string } = {}) {
  return mount(SharePanel, {
    props: {
      snapshot: over.shareCode === undefined ? snapshot : { ...snapshot, shareCode: over.shareCode },
      editToken: over.editToken ?? "held-token",
      authHeaders: { Authorization: "Bearer held-token" },
      shareUrl: `https://mahonia.app/s/${SHARE}`,
      flash,
    },
    attachTo: document.body,
  });
}

// the button, found by its label — the class it shares with "Replace this link"
// is deliberate (same quiet voice) and so can't identify it
const addBtn = (w: ReturnType<typeof mountPanel>) =>
  w.findAll("button").find((b) => b.text().includes("Add to your account"));

beforeEach(() => {
  snapshotsData = [];
  warmExporters.mockClear();
  flash.mockClear();
  ran.length = 0;
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

// Recent changes says who only when more than one hand shows up in it.
describe("SharePanel — who made a change", () => {
  const entry = (id: number, reason: string, by: ChangeAuthor | null): SnapshotMeta => ({
    id,
    version: id,
    reason,
    by,
    createdAt: new Date().toISOString(),
    itemCount: 1,
  });
  async function openLog() {
    const w = mountPanel();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Recent changes"))!.trigger("click");
    await flushPromises();
    return w;
  }

  it("says nothing when every change is yours", async () => {
    snapshotsData = [entry(2, "Added Pot", { kind: "you" }), entry(1, "Added Stakes", { kind: "you" })];
    const w = await openLog();
    expect(w.text()).toContain("Added Pot");
    expect(w.text()).not.toContain("You");
  });

  it("names each hand once there is more than one", async () => {
    snapshotsData = [
      entry(3, "Added Pot", { kind: "assistant" }),
      entry(2, "Added Cup", { kind: "named", name: "Sam" }),
      entry(1, "Added Stakes", { kind: "you" }),
    ];
    const w = await openLog();
    expect(w.text()).toContain("· Assistant");
    expect(w.text()).toContain("· Sam");
    expect(w.text()).toContain("· You");
  });

  it("counts an unnamed change as a hand beside an assistant's", async () => {
    snapshotsData = [entry(2, "Added Pot", { kind: "assistant" }), entry(1, "Added Stakes", null)];
    const w = await openLog();
    expect(w.text()).toContain("· Assistant");
  });
});

describe("SharePanel — the tabs", () => {
  const tabs = (w: ReturnType<typeof mountPanel>) => w.findAll('[role="tab"]');
  const selected = (w: ReturnType<typeof mountPanel>) => w.get('[role="tab"][aria-selected="true"]').text();
  // every pressable row in the open tab, by its accessible name
  const rowNames = (w: ReturnType<typeof mountPanel>) =>
    w.findAll('[role="tabpanel"] .menu__item').map((r) => r.attributes("aria-label") ?? r.text().trim());

  it("opens on Share, with both links", () => {
    const w = mountPanel();
    expect(tabs(w).map((t) => t.text())).toEqual(["Share", "Export"]);
    expect(selected(w)).toBe("Share");
    // (the default state here is a held list the signed-in account doesn't have yet)
    expect(rowNames(w)).toEqual([
      "Copy read-only link",
      "Copy edit link",
      "Recent changes",
      "Add to your account",
      "Replace edit link",
    ]);
  });

  it("has no edit-link row on a claimed open, and offers a new link instead", () => {
    const w = mountPanel({ editToken: "" });
    expect(rowNames(w)).toEqual(["Copy read-only link", "Recent changes", "Get a new edit link"]);
  });

  it("puts the link before the files on Export, and warms the exporters", async () => {
    const w = mountPanel();
    expect(warmExporters).not.toHaveBeenCalled();
    await tabs(w)[1]!.trigger("click");

    expect(selected(w)).toBe("Export");
    expect(warmExporters).toHaveBeenCalledOnce();
    expect(w.text()).toContain("Sending this to someone?");
    expect(rowNames(w)).toEqual(["Export text", "Export markdown", "Export csv", "Export json"]);
    // and the card's button is the same copy as the Share tab's first row
    await w.findAll("button").find((b) => b.text().includes("Copy read-only link"))!.trigger("click");
    expect(w.emitted().close).toHaveLength(1);
    expect(w.emitted().copyRead).toHaveLength(1);
  });

  it("moves between the tabs with the arrows", async () => {
    const w = mountPanel();
    await w.get('[role="tablist"]').trigger("keydown", { key: "ArrowRight" });
    expect(selected(w)).toBe("Export");
    await w.get('[role="tablist"]').trigger("keydown", { key: "ArrowRight" });
    expect(selected(w)).toBe("Share");
  });

  it("closes first, and the export's toast still lands once the panel is gone", async () => {
    const w = mountPanel();
    await tabs(w)[1]!.trigger("click");
    await w.findAll(".share__row")[2]!.trigger("click");
    expect(w.emitted().close).toHaveLength(1);
    expect(ran).toEqual(["csv"]);
    // what the editor does on close: the panel is v-if'd away before the export
    // finishes, and an unmounted component's emits go nowhere
    w.unmount();
    await flushPromises();
    expect(flash).toHaveBeenCalledWith("csv done");
  });

  it("is one line and no tabs on a draft, which has no links and nothing to export", () => {
    const w = mountPanel({ shareCode: "" });
    expect(tabs(w)).toHaveLength(0);
    expect(w.text()).toContain("Add an item");
  });
});
