// @vitest-environment nuxt
//
// The /gear page against the vault API's real route table.
//
// The regression this pins: the page rename (#224, /vault → /gear) also rewrote the
// page's OWN fetch URLs to /api/gear/*, but the server routes live at /api/vault/*
// on purpose (see the /vault redirect note in nuxt.config) — so every load answered
// 404 and the page opened straight onto "Couldn’t load your gear." A suite that
// stubs vaultFetch with fixtures can never see that class of bug, so here the stub
// passes through to $fetch and the endpoints are registered at the real paths:
// registerEndpoint 404s anything unregistered, which is exactly what production did.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { readBody } from "h3";
import type { VaultEntry, VaultFolder } from "~~/shared/vault";
import GearPage from "~/pages/gear.vue";

// hasVault true so the page loads; vaultFetch REAL so the page's URL choice has to
// resolve against the routes below — the same passthrough gearList.nuxt.test.ts uses.
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  vaultFetch: <T,>(url: string, opts?: Parameters<typeof $fetch>[1]) =>
    $fetch(url, { ...opts, credentials: "same-origin" }) as Promise<T>,
}));

// Node's own localStorage global throws on every method without a backing file; the
// page reads its unit preference and folder collapse state through it at mount.
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
});

const entry = (id: number, name: string): VaultEntry => ({
  id,
  name,
  brand: "Brand",
  weightMg: 250_000,
  normKey: `brand|${name.toLowerCase()}|`,
  timesSeen: 1,
  lastUsedAt: "2026-08-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
});

let listRows: VaultEntry[] = [];
let listFolders: VaultFolder[] = [];
registerEndpoint("/api/vault/list", () => ({
  items: listRows,
  removed: [],
  folders: listFolders,
}));

// what "Remove" sent — the id is the assertion, the ok is what lets the row leave
let removedIds: number[] = [];
registerEndpoint("/api/vault/remove", {
  method: "POST",
  handler: async (event) => {
    const body = await readBody<{ id: number }>(event);
    removedIds.push(body.id);
    return { ok: true };
  },
});

let wrapper: ReturnType<typeof mount> | undefined;

/** A registered endpoint's round trip crosses more than one task, so a single
 *  flushPromises can return with the response still in flight — loop a few turns. */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await flushPromises();
    await nextTick();
  }
}

/** Mount the page and let the load round-trip settle (ClientOnly needs the tick). */
async function openPage() {
  wrapper = mount(GearPage, { attachTo: document.body });
  await settle();
  return wrapper;
}

describe("the /gear page's vault calls", () => {
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
    storage.clear();
    removedIds = [];
  });

  it("loads the gear from /api/vault/list rather than erroring", async () => {
    listRows = [entry(1, "Duplex"), entry(2, "Kakwa 40")];
    listFolders = [];
    const w = await openPage();
    // the error line rendering instead of rows is exactly the shipped bug
    expect(w.find(".vault__error").exists()).toBe(false);
    const rows = w.findAll(".vault__row");
    expect(rows).toHaveLength(2);
    expect(w.text()).toContain("Duplex");
    expect(w.text()).toContain("Kakwa 40");
  });

  it("removes a row through /api/vault/remove", async () => {
    listRows = [entry(7, "Duplex")];
    listFolders = [];
    const w = await openPage();
    await w.get('button[aria-label="Remove Brand Duplex from My Gear"]').trigger("click");
    await settle();
    expect(removedIds).toEqual([7]);
    expect(w.find(".vault__error").exists()).toBe(false);
    expect(w.findAll(".vault__row")).toHaveLength(0);
  });
});
