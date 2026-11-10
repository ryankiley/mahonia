// My Gear offline: this device's copy, per account, and what the list's My Gear pane
// shows from it. Offline, /api/auth/me never answers, so a signed-in visitor reads as
// "presumed", never signed in: the pane asked them to sign in, and nothing on the
// device could have shown their gear anyway (2026-11-09).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import VaultPane from "~/components/VaultPane.vue";
import { forgetGearCopy, gearCopyKey } from "~/utils/gearCopy";
import { readGearCopy, useVaultList, useVaultOps, writeGearCopy } from "~/composables/useVaultList";
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
const access = { hasVault: ref(false), read: vi.fn<(url?: string) => Promise<{ items: VaultEntry[] }>>() };
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: computed(() => access.hasVault.value),
  vaultKnown: computed(() => true),
  vaultFetch: (url: string) => access.read(url),
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

// The composable itself, for what no surface shows directly: whose copy a write lands in,
// when the gear is read-only, and asking again.
const harness = (opts?: Parameters<typeof useVaultList>[0]) =>
  defineComponent({ setup: () => useVaultList(opts), render: () => null });
const Harness = harness();
const signIn = () => {
  setCookie("mh_signed_in", "1");
  useState("session").value = { state: "signedIn", user: { owner: OWNER, email: "a@b.c", displayName: null } };
  access.hasVault.value = true;
};
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("the copy and the account it belongs to", () => {
  // Signed in as A on one tab; signing in as B on another changes the cookie under this
  // one, whose page still holds A's gear. A's gear must not become B's offline copy.
  it("is written only for the account the gear was loaded for", async () => {
    signIn();
    access.read.mockResolvedValue({ items: GEAR });
    const h = mount(Harness);
    await flushPromises();
    expect(readGearCopy(OWNER)?.items).toHaveLength(2);

    setCookie("mh_session_owner", OTHER);
    // a row added the way the page adds one (onItemAdded replaces the array)
    h.vm.items = [piece(3, "Spork", "Utensil"), ...h.vm.items];
    await flushPromises();
    expect(readGearCopy(OTHER)).toBeNull();
    expect(readGearCopy(OWNER)?.items).toHaveLength(2);
  });

  it("drops entries that would break the page rather than painting them", () => {
    localStorage.setItem(
      gearCopyKey(OWNER)!,
      JSON.stringify({ items: [GEAR[0], null, { id: "x", name: "Bad" }, { ...GEAR[1], parts: [{ id: 1 }] }], savedAt: 5 }),
    );
    expect(readGearCopy(OWNER)).toEqual({ items: [GEAR[0]], savedAt: 5 });
  });
});

describe("read-only My Gear", () => {
  it("refuses a change while the page says so, without sending it", async () => {
    const ops = useVaultOps(() => true);
    await expect(ops.op({ t: "edit", id: 1, patch: { name: "X" } })).resolves.toEqual({ ok: false, reason: "offline" });
    await expect(ops.remove(1, true)).resolves.toBe(false);
    expect(access.read).not.toHaveBeenCalled();
  });

  // The copy can be behind an edit made on another device; a row of it must not be
  // editable until the server's answer replaces it.
  it("holds while the copy is showing online, until the server answers", async () => {
    signIn();
    writeGearCopy(GEAR, OWNER, Date.now() - 60_000);
    const answer = deferred<{ items: VaultEntry[] }>();
    access.read.mockReturnValue(answer.promise);
    const h = mount(Harness);
    await flushPromises();
    expect(h.vm.items).toHaveLength(2);
    expect(h.vm.offline).toBe(false);
    expect(h.vm.readonly).toBe(true);

    answer.resolve({ items: GEAR });
    await flushPromises();
    expect(h.vm.readonly).toBe(false);
  });
});

describe("asking again", () => {
  it("re-asks when the page comes back into view, with no online event", async () => {
    signIn();
    access.read.mockRejectedValueOnce(new Error("offline"));
    const h = mount(Harness);
    await flushPromises();
    expect(h.vm.offline).toBe(true);

    access.read.mockResolvedValue({ items: GEAR });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(h.vm.offline).toBe(false);
    expect(h.vm.items).toHaveLength(2);
  });

  it("stays offline while a retry is in flight, so the note and controls don't blink", async () => {
    signIn();
    writeGearCopy(GEAR, OWNER);
    access.read.mockRejectedValueOnce(new Error("offline"));
    const h = mount(Harness);
    await flushPromises();
    expect(h.vm.offline).toBe(true);

    const answer = deferred<{ items: VaultEntry[] }>();
    access.read.mockReturnValue(answer.promise);
    document.dispatchEvent(new Event("visibilitychange"));
    await nextTick();
    expect(h.vm.offline).toBe(true);
    expect(h.vm.readonly).toBe(true);
    answer.resolve({ items: GEAR });
    await flushPromises();
    expect(h.vm.offline).toBe(false);
  });
});

// The pane opens beside a column that is still moving aside, and a server answer that
// landed in the middle of that move re-rendered every row in a frame the move stood
// still for (2026-11-09).
describe("the server's answer over the copy", () => {
  it("leaves the rows alone when it is the copy already on screen, and re-dates the copy", async () => {
    signIn();
    writeGearCopy(GEAR, OWNER, 1_000);
    access.read.mockResolvedValue({ items: structuredClone(GEAR) });
    const before = vi.fn(() => Promise.resolve());
    const h = mount(harness({ before }));
    const painted = h.vm.items;
    await flushPromises();
    // the same array, so nothing re-rendered, and nothing to wait for
    expect(h.vm.items).toBe(painted);
    expect(before).not.toHaveBeenCalled();
    expect(h.vm.readonly).toBe(false);
    expect(readGearCopy(OWNER)!.savedAt).toBeGreaterThan(1_000);
  });

  it("waits for the surface's say-so before a different answer replaces what is listed", async () => {
    signIn();
    writeGearCopy(GEAR, OWNER);
    const more = [...GEAR, piece(3, "X-Mid")];
    access.read.mockResolvedValue({ items: more });
    const landed = deferred<void>();
    const h = mount(harness({ before: () => landed.promise }));
    await flushPromises();
    // answered, and still the copy: the column hasn't landed
    expect(h.vm.items).toHaveLength(2);
    expect(h.vm.readonly).toBe(true);

    landed.resolve();
    await flushPromises();
    expect(h.vm.items).toHaveLength(3);
    expect(h.vm.readonly).toBe(false);
    expect(readGearCopy(OWNER)!.items).toHaveLength(3);
  });

  it("holds the first read too, when there was no copy to paint", async () => {
    signIn();
    access.read.mockResolvedValue({ items: GEAR });
    const landed = deferred<void>();
    const h = mount(harness({ before: () => landed.promise }));
    await flushPromises();
    expect(h.vm.items).toHaveLength(0);
    expect(h.vm.loading).toBe(true);

    landed.resolve();
    await flushPromises();
    expect(h.vm.items).toHaveLength(2);
    expect(h.vm.loading).toBe(false);
  });
});

describe("the copy and the account it belongs to, mid-read", () => {
  // The read answers after a sign-in elsewhere changed the cookie: dropped, and asked
  // again for whoever holds the browser now, rather than leaving the page stuck on the
  // old copy, read-only, with nothing saying why.
  it("asks again when the answer comes back for an account no longer here", async () => {
    signIn();
    writeGearCopy(GEAR, OWNER);
    const first = deferred<{ items: VaultEntry[] }>();
    access.read.mockReturnValueOnce(first.promise).mockResolvedValue({ items: [piece(9, "Bivy", "Bivy")] });
    const h = mount(Harness);
    await flushPromises();
    expect(h.vm.readonly).toBe(true);

    setCookie("mh_session_owner", OTHER);
    first.resolve({ items: GEAR });
    await flushPromises();
    expect(h.vm.items.map((i) => i.name)).toEqual(["Bivy"]);
    expect(h.vm.readonly).toBe(false);
    expect(readGearCopy(OTHER)?.items.map((i) => i.name)).toEqual(["Bivy"]);
    expect(readGearCopy(OWNER)?.items).toHaveLength(2);
  });

  it("starts the next account's first ask as a question, not as offline", async () => {
    signIn();
    access.read.mockRejectedValue(new Error("offline"));
    const h = mount(Harness);
    await flushPromises();
    expect(h.vm.offline).toBe(true);

    // the account leaves, and a sign-in starts asking again
    useState("session").value = { state: "signedOut" };
    access.hasVault.value = false;
    await flushPromises();
    useState("session").value = { state: "unresolved" };
    useState("session-pending").value = true;
    await flushPromises();
    expect(h.vm.offline).toBe(false);
    expect(h.vm.loading).toBe(true);
  });
});

describe("asking again, but not from a hidden tab", () => {
  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("leaves a backgrounded tab alone", async () => {
    signIn();
    access.read.mockRejectedValue(new Error("offline"));
    mount(Harness);
    await flushPromises();
    expect(access.read).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await flushPromises();
    expect(access.read).toHaveBeenCalledTimes(1);
  });
});
