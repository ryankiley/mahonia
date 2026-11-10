// My Gear offline: this device's copy, per account, and what the list's My Gear pane
// shows from it. Offline, /api/auth/me never answers, so a signed-in visitor reads as
// "presumed", never signed in: the pane asked them to sign in, and nothing on the
// device could have shown their gear anyway (2026-11-09).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import VaultPane from "~/components/VaultPane.vue";
import { forgetGearCopy, readGearCopy, writeGearCopy } from "~/utils/gearCopy";
import type { VaultEntry } from "~~/shared/vault";

const OWNER = "a1b2c3d4e5f60718";
const OTHER = "ffffffffffffffff";
const piece = (id: number, name: string, commonName = "Tent"): VaultEntry => ({
  id,
  name,
  commonName,
  weightMg: 500_000,
  normKey: `|${name.toLowerCase()}|`,
  timesSeen: 1,
  lastUsedAt: "2026-11-01T00:00:00Z",
  createdAt: "2026-11-01T00:00:00Z",
});
const GEAR = [piece(1, "Duplex"), piece(2, "Pocket Rocket", "Stove")];

// what the server would say, per test
const access = { hasVault: ref(false), read: vi.fn<() => Promise<{ items: VaultEntry[] }>>() };
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: computed(() => access.hasVault.value),
  vaultKnown: computed(() => true),
  vaultFetch: () => access.read(),
}));
mockNuxtImport("useGearList", () => () => ({
  snapshot: ref({ folders: [], items: [], displayUnit: "g" }),
  addVaultItem: vi.fn(),
  moveItem: vi.fn(),
  vaultGear: ref(new Map()),
  vaultGearAsked: ref(new Set()),
  vaultGearSettled: ref(true),
}));
mockNuxtImport("useItemDnd", () => () => ({ startInsert: vi.fn(), dragId: ref(null) }));

enableAutoUnmount(afterEach);

const setCookie = (name: string, value: string | null) =>
  (document.cookie = value === null ? `${name}=; Max-Age=0; path=/` : `${name}=${value}; path=/`);

beforeEach(() => {
  localStorage.clear();
  setCookie("mh_session_owner", OWNER);
  access.hasVault.value = false;
  access.read.mockReset();
  // the session as an offline launch leaves it: asked, and the ask failed
  useState("session").value = { state: "unresolved" };
  useState("session-pending").value = false;
});
afterEach(() => {
  setCookie("mh_signed_in", null);
  setCookie("mh_session_owner", null);
});

async function openPane() {
  const wrapper = mount(VaultPane, { props: { width: 368 }, attachTo: document.body });
  await flushPromises();
  await nextTick();
  return wrapper;
}
const rowNames = (pane: Awaited<ReturnType<typeof openPane>>) => pane.findAll(".vp__add").map((b) => b.text());

describe("the device's copy of My Gear", () => {
  it("is kept per account, so another account on this browser can't read it", () => {
    writeGearCopy(GEAR, OWNER, 1_000);
    expect(readGearCopy(OWNER)).toEqual({ items: GEAR, savedAt: 1_000 });
    expect(readGearCopy(OTHER)).toBeNull();
    // and with no owner marker there is nothing to key it by, so none is kept or read
    writeGearCopy(GEAR, null);
    expect(readGearCopy(null)).toBeNull();
  });

  it("goes with the account: forgotten, it's gone", () => {
    writeGearCopy(GEAR, OWNER);
    writeGearCopy(GEAR, OTHER);
    forgetGearCopy(OWNER);
    expect(readGearCopy(OWNER)).toBeNull();
    expect(readGearCopy(OTHER)).not.toBeNull();
  });

  it("is dropped rather than kept stale when it outgrows its room", () => {
    writeGearCopy(GEAR, OWNER);
    const huge = Array.from({ length: 10_000 }, (_, i) => piece(i, `Piece number ${i} with a long name`));
    writeGearCopy(huge, OWNER);
    expect(readGearCopy(OWNER)).toBeNull();
  });

  it("is written from the server's answer", async () => {
    setCookie("mh_signed_in", "1");
    useState("session").value = { state: "signedIn", user: { owner: OWNER, email: "a@b.c", displayName: null } };
    access.hasVault.value = true;
    access.read.mockResolvedValue({ items: GEAR });
    await openPane();
    expect(readGearCopy(OWNER)?.items.map((i) => i.name)).toEqual(["Duplex", "Pocket Rocket"]);
  });
});

describe("the My Gear pane offline", () => {
  it("shows a signed-in visitor their gear from the copy, with its age, not a sign-in prompt", async () => {
    setCookie("mh_signed_in", "1");
    writeGearCopy(GEAR, OWNER, Date.now() - 3 * 60 * 60 * 1000);
    const pane = await openPane();
    expect(pane.text()).not.toContain("Sign in");
    expect(pane.find(".vp__offline").text()).toBe("Offline · last updated 3 hours ago");
    expect(rowNames(pane)).toEqual([expect.stringContaining("Duplex"), expect.stringContaining("Pocket Rocket")]);
    // the copy still adds to the list: a list edit queues offline
    expect(pane.find(".vp__add").attributes("disabled")).toBeUndefined();
    expect(access.read).not.toHaveBeenCalled();
  });

  it("says there is no copy rather than that there is no gear", async () => {
    setCookie("mh_signed_in", "1");
    const pane = await openPane();
    expect(pane.find(".vp__offline").text()).toBe("You’re offline, and this device hasn’t kept a copy of your gear yet.");
    expect(pane.text()).not.toContain("No gear saved yet");
    expect(pane.text()).not.toContain("Sign in");
  });

  it("keeps the gear on screen when the read fails after signing in", async () => {
    setCookie("mh_signed_in", "1");
    useState("session").value = { state: "signedIn", user: { owner: OWNER, email: "a@b.c", displayName: null } };
    access.hasVault.value = true;
    access.read.mockRejectedValue(new Error("offline"));
    writeGearCopy(GEAR, OWNER, Date.now());
    const pane = await openPane();
    expect(pane.find(".vp__offline").text()).toBe("Offline · last updated just now");
    expect(rowNames(pane)).toEqual([expect.stringContaining("Duplex"), expect.stringContaining("Pocket Rocket")]);
  });

  it("waits, rather than reading as offline, while the session is still being asked", async () => {
    setCookie("mh_signed_in", "1");
    useState("session-pending").value = true;
    const pane = await openPane();
    expect(pane.find(".vp__offline").exists()).toBe(false);
    expect(pane.text()).toContain("Loading your gear…");
  });

  it("still asks a browser with no account to sign in", async () => {
    writeGearCopy(GEAR, OWNER);
    useState("session").value = { state: "signedOut" };
    const pane = await openPane();
    expect(pane.text()).toContain("Sign in");
    expect(rowNames(pane)).toEqual([]);
  });
});
