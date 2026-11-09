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
import { stubLocalStorage } from "./helpers/storage";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { readBody } from "h3";
import type { VaultEntry } from "~~/shared/vault";
import GearPage from "~/pages/gear.vue";

// hasVault true so the page loads; vaultFetch REAL so the page's URL choice has to
// resolve against the routes below — the same passthrough gearList.nuxt.test.ts uses.
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(true),
  // Mirrors the real vaultFetch, including WHY it casts: `$fetch` is generic over
  // the app's routes, so typing the call drags Nuxt's route matcher in and blows
  // TypeScript's depth limit from a mock (see useVaultAccess).
  vaultFetch: <T,>(url: string, opts?: Record<string, unknown>) => {
    const call = $fetch as unknown as (u: string, o: unknown) => Promise<unknown>;
    return call(url, { ...opts, credentials: "same-origin" }) as Promise<T>;
  },
}));

const storage = stubLocalStorage();

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

// the add row's suggestions
let catalogHits: Record<string, unknown>[] = [];
registerEndpoint("/api/catalog/search", () => ({ results: catalogHits }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });
const NANO_PUFF = {
  id: 2106,
  brand: "Patagonia",
  name: "Nano Puff Jacket",
  variant: "Men’s Medium",
  commonName: "Insulated jacket",
  weightMg: 369_000,
  verified: true,
  categoryHint: "clothing",
};

let listRows: VaultEntry[] = [];
registerEndpoint("/api/vault/list", () => ({ items: listRows, removed: [] }));

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

// an add, optionally held so a case can type while it's out
let itemsHeld: Promise<void> | null = null;
let addedNames: string[] = [];
let addedOps: Record<string, unknown>[] = [];
// an edit answers with the row as it now stands, the way the real route does
let editedOps: Record<string, unknown>[] = [];
registerEndpoint("/api/vault/items", {
  method: "POST",
  handler: async (event) => {
    const body = await readBody<{ op: { t: string; name: string; id: number; patch: Record<string, unknown> } }>(event);
    if (body.op.t === "edit") {
      editedOps.push(body.op);
      const row = listRows.find((r) => r.id === body.op.id);
      return { ok: true, item: { ...row, ...body.op.patch } };
    }
    addedNames.push(body.op.name);
    addedOps.push(body.op);
    if (itemsHeld) await itemsHeld;
    // the row as it landed, the way the real route answers an add
    return { ok: true, item: { ...entry(900 + addedNames.length, body.op.name), brand: undefined } };
  },
});

enableAutoUnmount(afterEach);

/** How many rows the page shows. A registered endpoint's round trip crosses more than
 *  one task, so the page is waited on by what it RENDERS rather than by flushing a
 *  guessed number of turns. */
const rows = (w: ReturnType<typeof mount>) => w.findAll(".vault__row");

/** Mount the page and wait for the load round-trip to put every served row on it. */
async function openPage() {
  const w = mount(GearPage, { attachTo: document.body });
  await vi.waitFor(() => expect(rows(w)).toHaveLength(listRows.length));
  return w;
}

describe("the /gear page's vault calls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    storage.clear();
    removedIds = [];
    addedNames = [];
    addedOps = [];
    editedOps = [];
    itemsHeld = null;
  });

  it("loads the gear from /api/vault/list rather than erroring", async () => {
    listRows = [entry(1, "Duplex"), entry(2, "Kakwa 40")];
    const w = await openPage();
    // the error line rendering instead of rows is exactly the shipped bug
    expect(w.find(".vault__error").exists()).toBe(false);
    expect(rows(w)).toHaveLength(2);
    expect(w.text()).toContain("Duplex");
    expect(w.text()).toContain("Kakwa 40");
  });

  // My Gear has no folders to keep: it groups itself by what each piece is.
  it("groups the gear by kind, Other last, and keeps kits on their own tab", async () => {
    listRows = [
      entry(1, "Widget"),
      { ...entry(2, "Duplex"), commonName: "Tent" },
      { ...entry(3, "Cook kit"), kind: "kit", parts: [] },
    ];
    const w = mount(GearPage, { attachTo: document.body });
    // the Gear tab: the pieces, by kind
    await vi.waitFor(() => expect(rows(w)).toHaveLength(2));
    expect(w.findAll(".vsec__kind").map((h) => h.text())).toEqual(["Shelter", "Other"]);
    // the Kits tab: the kit as a section of its own, named in its heading, and no kinds
    const kitsTab = w.findAll(".modebar__opt").find((b) => b.text().includes("Kits"))!;
    await kitsTab.trigger("click");
    await vi.waitFor(() => expect(w.findAll(".kitsec")).toHaveLength(1));
    expect(w.get<HTMLInputElement>(".kitsec .folder__name").element.value).toBe("Cook kit");
    expect(w.findAll(".vsec__kind")).toHaveLength(0);
  });

  it("removes a row through /api/vault/remove", async () => {
    listRows = [entry(7, "Duplex")];
    const w = await openPage();
    await w.get('button[aria-label="Remove Brand Duplex from My Gear"]').trigger("click");
    await vi.waitFor(() => expect(rows(w)).toHaveLength(0));
    expect(removedIds).toEqual([7]);
    expect(w.find(".vault__error").exists()).toBe(false);
  });

  // A piece's weight reads in the unit picked for it, the list row's unit picker on /gear:
  // shown at once, saved as an edit, and the stored figure never touched.
  describe("a piece's own weight unit", () => {
    it("reads in the unit picked on its row, and saves the pick", async () => {
      listRows = [entry(1, "Duplex")];
        const w = await openPage();
      const weight = () => rows(w).find((r) => r.text().includes("Duplex"))!.get(".vault__weight").text();
      expect(weight()).toContain("250");
      await w.get('button[aria-label="Weight unit for Brand Duplex"]').trigger("click");
      await nextTick();
      const oz = w.findAll('[role="menuitem"]').find((b) => b.text().trim() === "oz")!;
      await oz.trigger("click");
      await vi.waitFor(() => expect(editedOps).toEqual([{ t: "edit", id: 1, patch: { entryUnit: "oz" } }]));
      expect(weight()).toContain("8.8");
      expect(weight()).toContain("oz");
    });
  });

  describe("adding gear by hand", () => {
    const filed = entry(1, "Duplex");
    // the list editor's own name field (ItemInput), catalog-only and pick-only
    const nameField = (w: ReturnType<typeof mount>) => w.get<HTMLInputElement>(".vaddrow .ac__input");
    const openForm = async (w: ReturnType<typeof mount>) => {
      await w.get(".vault__tabadd").trigger("click");
      await nextTick();
    };

    it("opens a fresh pair after an add, with the caret back in the name", async () => {
      listRows = [filed];
      const w = await openPage();
      await openForm(w);
      await nameField(w).setValue("Stove");
      await w.get("form.vaddrow").trigger("submit");
      await vi.waitFor(() => expect(addedNames).toEqual(["Stove"]));
      await vi.waitFor(() => expect(nameField(w).element.value).toBe(""));
      await nextTick();
      expect(document.activeElement).toBe(nameField(w).element);
    });

    // A piece sorts itself into its kind, so the page says where it went, with Undo.
    it("says which kind an added piece went to, and offers Undo", async () => {
      listRows = [filed];
      const w = await openPage();
      await openForm(w);
      await nameField(w).setValue("Stove");
      await w.get("form.vaddrow").trigger("submit");
      await vi.waitFor(() => expect(w.find(".undobar").exists()).toBe(true));
      expect(w.get(".undobar").text()).toContain("Added Stove to Kitchen");
      expect(w.get(".undobar").text()).toContain("Undo");
    });

    it("keeps what was typed while the add was out", async () => {
      let land = () => {};
      itemsHeld = new Promise((r) => (land = r));
      listRows = [filed];
      const w = await openPage();
      await openForm(w);
      await nameField(w).setValue("Stove");
      await w.get("form.vaddrow").trigger("submit");
      await vi.waitFor(() => expect(addedNames).toEqual(["Stove"]));

      await nameField(w).setValue("Windscreen");
      land();
      await new Promise((r) => setTimeout(r, 40));
      expect(nameField(w).element.value).toBe("Windscreen");
    });

    // Picking a catalog product adds it AS that product, in one press: the gear type is
    // what gives a hand-added row its icon and its place in a search, and before this a
    // name typed here never had one.
    it("adds a picked catalog product with its type, link and weight", async () => {
      catalogHits = [NANO_PUFF];
      listRows = [filed];
      const w = await openPage();
      await openForm(w);
      await nameField(w).setValue("nano puff");
      await vi.waitFor(() => expect(w.findAll('.vaddrow [role="option"]').length).toBe(1), { timeout: 2_000 });
      await w.get('.vaddrow [role="option"]').trigger("mousedown");
      await vi.waitFor(() =>
        expect(addedOps).toEqual([
          expect.objectContaining({
            t: "add",
            brand: "Patagonia",
            name: "Nano Puff Jacket",
            variant: "Men’s Medium",
            commonName: "Insulated jacket",
            catalogItemId: 2106,
            weightMg: 369_000,
          }),
        ]),
      );
    });

    it("keeps a weight you typed over the catalog's", async () => {
      catalogHits = [NANO_PUFF];
      listRows = [filed];
      const w = await openPage();
      await openForm(w);
      await w.get(".vaddrow__weight").setValue("352");
      await nameField(w).setValue("nano puff");
      await vi.waitFor(() => expect(w.findAll('.vaddrow [role="option"]').length).toBe(1), { timeout: 2_000 });
      await w.get('.vaddrow [role="option"]').trigger("mousedown");
      await vi.waitFor(() => expect(addedOps).toEqual([expect.objectContaining({ catalogItemId: 2106, weightMg: 352_000 })]));
    });
  });
});

describe("the /gear page's words and names", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    storage.clear();
  });

  it("puts a row's whole name in its title, for when the row clips it", async () => {
    listRows = [{ ...entry(1, "Ether Light XT Insulated Air Sleeping Mat"), variant: "Regular Wide" }];
    const w = await openPage();
    expect(w.get(".gear__name").attributes("title")).toBe("Brand Ether Light XT Insulated Air Sleeping Mat Regular Wide");
  });
});
