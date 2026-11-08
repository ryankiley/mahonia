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
import type { VaultEntry, VaultFolder } from "~~/shared/vault";
import GearPage from "~/pages/gear.vue";
import { useDialogs } from "~/composables/useDialogs";

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

// what a drag filed — the op is the assertion, the reload after it is the page's own
let folderOps: Record<string, unknown>[] = [];
registerEndpoint("/api/vault/folders", {
  method: "POST",
  handler: async (event) => {
    const body = await readBody<{ op: Record<string, unknown> }>(event);
    folderOps.push(body.op);
    return { ok: true };
  },
});

// an add, optionally held so a case can type while it's out
let itemsHeld: Promise<void> | null = null;
let addedNames: string[] = [];
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
    if (itemsHeld) await itemsHeld;
    return { ok: true };
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

/** Drag a row onto a section with the real pointer events: the press arms, the first
 *  move past the threshold lifts it, the next one reads what's under the pointer.
 *  Sideways, because happy-dom's page has no height and any vertical travel would read
 *  as leaving it, which cancels. */
async function dragRowOnto(row: Element, section: Element) {
  const at = (x: number) => ({ pointerId: 1, button: 0, clientX: x, clientY: 0, bubbles: true });
  vi.spyOn(document, "elementFromPoint").mockReturnValue(section);
  row.dispatchEvent(new PointerEvent("pointerdown", at(0)));
  window.dispatchEvent(new PointerEvent("pointermove", at(40)));
  window.dispatchEvent(new PointerEvent("pointermove", at(80)));
  await nextTick();
  window.dispatchEvent(new PointerEvent("pointerup", at(80)));
  await nextTick();
}

describe("the /gear page's vault calls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    storage.clear();
    removedIds = [];
    folderOps = [];
    addedNames = [];
    editedOps = [];
    itemsHeld = null;
  });

  it("loads the gear from /api/vault/list rather than erroring", async () => {
    listRows = [entry(1, "Duplex"), entry(2, "Kakwa 40")];
    listFolders = [];
    const w = await openPage();
    // the error line rendering instead of rows is exactly the shipped bug
    expect(w.find(".vault__error").exists()).toBe(false);
    expect(rows(w)).toHaveLength(2);
    expect(w.text()).toContain("Duplex");
    expect(w.text()).toContain("Kakwa 40");
  });

  it("removes a row through /api/vault/remove", async () => {
    listRows = [entry(7, "Duplex")];
    listFolders = [];
    const w = await openPage();
    await w.get('button[aria-label="Remove Brand Duplex from My Gear"]').trigger("click");
    await vi.waitFor(() => expect(rows(w)).toHaveLength(0));
    expect(removedIds).toEqual([7]);
    expect(w.find(".vault__error").exists()).toBe(false);
  });

  describe("dragging a row between sections", () => {
    const filed = { ...entry(1, "Duplex"), folderId: 3 };
    const loose = entry(2, "Kakwa 40");
    const cook: VaultFolder = { id: 3, name: "Cook kit", sortOrder: 0 } as VaultFolder;
    const rowNamed = (w: ReturnType<typeof mount>, name: string) =>
      rows(w).find((r) => r.text().includes(name))!.element;

    it("files a row into a folder", async () => {
      listRows = [filed, loose];
      listFolders = [cook];
      const w = await openPage();
      await dragRowOnto(rowNamed(w, "Kakwa 40"), w.get('[data-gear-folder="3"]').element);
      await vi.waitFor(() => expect(folderOps).toEqual([{ t: "move", itemId: 2, folderId: 3 }]));
      // the gesture ends with the drop: nothing stays lifted or lit
      expect(w.find(".vault__row--dragging").exists()).toBe(false);
      expect(w.find(".folder--drop-into").exists()).toBe(false);
    });

    // per pointermove, so an unchanged target has to cost nothing: every row on the page
    // re-renders with the page, and a vault runs to a couple of hundred of them
    it("re-renders nothing while the pointer stays over one section", async () => {
      listRows = [filed, loose];
      listFolders = [cook];
      const w = await openPage();
      vi.spyOn(document, "elementFromPoint").mockReturnValue(w.get('[data-gear-folder=""]').element);
      const at = (x: number) => ({ pointerId: 1, button: 0, clientX: x, clientY: 0, bubbles: true });
      rowNamed(w, "Duplex").dispatchEvent(new PointerEvent("pointerdown", at(0)));
      window.dispatchEvent(new PointerEvent("pointermove", at(40)));
      window.dispatchEvent(new PointerEvent("pointermove", at(80)));
      await nextTick();

      const updated = vi.fn();
      for (const row of w.findAllComponents({ name: "VaultGearRow" })) {
        // `u` is the instance's own updated-hook list; there's no public way in from outside
        const instance = row.getCurrentComponent() as unknown as { u: (() => void)[] | null };
        (instance.u ??= []).push(updated);
      }
      for (let x = 90; x < 100; x++) {
        window.dispatchEvent(new PointerEvent("pointermove", at(x)));
        await nextTick();
      }
      expect(updated).not.toHaveBeenCalled();
      window.dispatchEvent(new PointerEvent("pointercancel", at(100)));
    });

    it("lights the section under the pointer, Unfiled included, and only that one", async () => {
      listRows = [filed, loose];
      listFolders = [cook];
      const w = await openPage();
      const row = rowNamed(w, "Duplex");
      const unfiled = w.get('[data-gear-folder=""]').element;
      vi.spyOn(document, "elementFromPoint").mockReturnValue(unfiled);
      const at = (x: number) => ({ pointerId: 1, button: 0, clientX: x, clientY: 0, bubbles: true });
      row.dispatchEvent(new PointerEvent("pointerdown", at(0)));
      window.dispatchEvent(new PointerEvent("pointermove", at(40)));
      await nextTick();
      expect(w.find(".vault__row--dragging").exists()).toBe(true);
      expect(w.find(".folder--drop-into").exists()).toBe(false); // lifted, over nothing yet
      window.dispatchEvent(new PointerEvent("pointermove", at(80)));
      await nextTick();
      expect(w.findAll(".folder--drop-into").map((s) => s.element)).toEqual([unfiled]);
      window.dispatchEvent(new PointerEvent("pointercancel", at(80)));
      await nextTick();
      expect(w.find(".folder--drop-into").exists()).toBe(false);
      expect(folderOps).toEqual([]);
    });

    // "unfiled" is a real destination whose folder id is null, so it must not read as
    // "no drop target": the section lit up under the pointer and the drop did nothing.
    it("takes a row out of its folder when it lands on Unfiled", async () => {
      listRows = [filed, loose];
      listFolders = [cook];
      const w = await openPage();
      await dragRowOnto(rowNamed(w, "Duplex"), w.get('[data-gear-folder=""]').element);
      await vi.waitFor(() => expect(folderOps).toEqual([{ t: "move", itemId: 1, folderId: null }]));
    });
  });

  // A piece's weight reads in the unit picked for it, the list row's unit picker on /gear:
  // shown at once, saved as an edit, and the stored figure never touched.
  describe("a piece's own weight unit", () => {
    it("reads in the unit picked on its row, and saves the pick", async () => {
      listRows = [entry(1, "Duplex")];
      listFolders = [];
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
    const filed = { ...entry(1, "Duplex"), folderId: 3 };
    const cook: VaultFolder = { id: 3, name: "Cook kit", sortOrder: 0 } as VaultFolder;
    const nameField = (w: ReturnType<typeof mount>) => w.get<HTMLInputElement>(".vaddrow__name");
    const openForm = async (w: ReturnType<typeof mount>) => {
      await w.get(".folder__addbtn").trigger("click");
      await nextTick();
    };

    it("opens a fresh pair after an add, with the caret back in the name", async () => {
      listRows = [filed];
      listFolders = [cook];
      const w = await openPage();
      await openForm(w);
      await nameField(w).setValue("Stove");
      await w.get("form.vaddrow").trigger("submit");
      await vi.waitFor(() => expect(addedNames).toEqual(["Stove"]));
      await vi.waitFor(() => expect(nameField(w).element.value).toBe(""));
      await nextTick();
      expect(document.activeElement).toBe(nameField(w).element);
    });

    it("keeps what was typed while the add was out", async () => {
      let land = () => {};
      itemsHeld = new Promise((r) => (land = r));
      listRows = [filed];
      listFolders = [cook];
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
  });
});

describe("the /gear page's words and names", () => {
  afterEach(() => {
    // answer any question a case left open, so no promise outlives its test
    useDialogs().settleConfirm(false);
    document.body.innerHTML = "";
    storage.clear();
  });

  /** Ask to delete the "Cook kit" folder and return the question's sentence. */
  async function deleteQuestion(held: number) {
    listFolders = [{ id: 1, name: "Cook kit" }];
    listRows = Array.from({ length: held }, (_, i) => ({ ...entry(i + 1, `Pot ${i + 1}`), folderId: 1 }));
    const w = await openPage();
    await w.get('button[aria-label="Remove Cook kit"]').trigger("click");
    const { confirmState } = useDialogs();
    await vi.waitFor(() => expect(confirmState.open).toBe(true));
    return confirmState.message;
  }

  it("asks about one piece of gear in the singular", async () => {
    expect(await deleteQuestion(1)).toBe(
      "The gear in it stays in My Gear, just not in a folder.",
    );
  });

  it("asks about several in the plural", async () => {
    expect(await deleteQuestion(2)).toBe(
      "The 2 pieces of gear in it stay in My Gear, just not in a folder.",
    );
  });

  it("puts a row's whole name in its title, for when the row clips it", async () => {
    listFolders = [];
    listRows = [{ ...entry(1, "Ether Light XT Insulated Air Sleeping Mat"), variant: "Regular Wide" }];
    const w = await openPage();
    expect(w.get(".gear__name").attributes("title")).toBe("Brand Ether Light XT Insulated Air Sleeping Mat Regular Wide");
  });
});
