// @vitest-environment nuxt
//
// A catalog page's "Pack this" (app/utils/packFromCatalog) against the real
// controller on a fresh draft: the slug is resolved through the product endpoint,
// the row lands with an autocomplete pick's semantics (linked, weight and name left
// to the catalog, the link's weight stamped as the baseline), in the folder that
// matches the product's category — made when the draft has none — and the arrival
// trips the draft's first save. Endpoints go through registerEndpoint, as every
// Nuxt-environment suite here does (see gearList.nuxt.test.ts on why).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { readBody } from "h3";
import { stubLocalStorage } from "./helpers/storage";
import type { LocalListRecord } from "~~/shared/localList";
import type { ListSnapshot } from "~~/shared/types";
import { packFromCatalog } from "~/utils/packFromCatalog";

const records = new Map<string, LocalListRecord>();
mockNuxtImport("useLocalListStore", () => () => ({
  get: async (key: string) => records.get(key),
  set: async (key: string, record: LocalListRecord) => {
    records.set(key, JSON.parse(JSON.stringify(record)));
  },
  del: async (key: string) => {
    records.delete(key);
  },
}));
mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(false),
  vaultKnown: ref(true),
  vaultFetch: <T,>() => Promise.resolve({} as T),
}));
stubLocalStorage();

const PRODUCTS: Record<string, unknown> = {
  "durston/x-mid-2": {
    brand: "Durston",
    name: "X-Mid 2",
    commonName: "Tent",
    categoryHint: "shelter",
    slug: "durston/x-mid-2",
    variants: [{ id: 41, variant: null, weightMg: 887_000, weightSource: "manufacturer", sourceUrl: "https://durstongear.com/x", verified: true, kcal: null }],
  },
  "therm-a-rest/neoair-xlite-nxt": {
    brand: "Therm-a-Rest",
    name: "NeoAir XLite NXT",
    commonName: "Sleeping pad",
    categoryHint: "sleep",
    slug: "therm-a-rest/neoair-xlite-nxt",
    variants: [
      { id: 51, variant: "Regular", weightMg: 369_000, weightSource: "manufacturer", sourceUrl: "https://x.test/p", verified: true, kcal: null },
      { id: 52, variant: "Large", weightMg: 482_000, weightSource: "manufacturer", sourceUrl: "https://x.test/p", verified: true, kcal: null },
    ],
  },
  "clif/bar": {
    brand: "Clif",
    name: "Bar",
    commonName: "Energy bar",
    categoryHint: "consumable",
    slug: "clif/bar",
    variants: [{ id: 61, variant: null, weightMg: 68_000, weightSource: "manufacturer", sourceUrl: "https://x.test/c", verified: true, kcal: 250 }],
  },
};
registerEndpoint("/api/catalog/product", (event) => {
  const slug = new URL(event.node.req.url ?? "", "http://x").searchParams.get("slug") ?? "";
  const product = PRODUCTS[slug];
  if (!product) throw createError({ statusCode: 404 });
  return { product };
});
const used: number[][] = [];
registerEndpoint("/api/catalog/use", { method: "POST", handler: async (event) => { used.push(((await readBody(event)) as { ids: number[] }).ids); return {}; } });
let created: ListSnapshot | null = null;
registerEndpoint("/api/lists/create", {
  method: "POST",
  handler: async (event) => {
    const body = (await readBody(event)) as { title: string; data: { folders: ListSnapshot["folders"]; items: ListSnapshot["items"] } };
    created = { shareCode: "PACKC0DE0001", slug: "packed-aaa111", title: body.title || "Untitled list", description: "", displayUnit: "g", folders: body.data.folders, items: body.data.items, version: 1, isPublic: false };
    return { editToken: "packed-edit-token", snapshot: created };
  },
});
registerEndpoint("/api/edit/changes", () => ({ version: 1 }));

describe("packFromCatalog", () => {
  beforeEach(() => {
    used.length = 0;
    created = null;
    // dispose first: it writes the outgoing list's record, which would otherwise be
    // the draft the next startDraft restores
    useGearList().dispose();
    records.clear();
  });

  it("adds a single-variant product to the matching starter folder with pick semantics, and the draft saves", async () => {
    const c = useGearList();
    c.startDraft();
    expect(await packFromCatalog(c, "durston/x-mid-2")).toEqual({ ok: true, name: "Durston X-Mid 2" });
    const snap = c.snapshot.value!;
    const shelter = snap.folders.find((f) => f.colorKey === "shelter")!;
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0]).toMatchObject({
      folderId: shelter.id,
      name: "X-Mid 2",
      brand: "Durston",
      commonName: "Tent",
      unitWeightMg: 887_000,
      catalogWeightMgAtLink: 887_000,
      catalogItemId: 41,
      classification: null,
      qty: 1,
    });
    // the reducer stores a false override as absent; either reading is "the catalog's"
    expect(snap.items[0]!.weightOverridden ?? false).toBe(false);
    expect(snap.items[0]!.nameOverridden ?? false).toBe(false);
    expect(snap.items[0]!.variant).toBeUndefined();
    await vi.waitFor(() => expect(created).not.toBeNull());
    expect(used).toEqual([[41]]);
  });

  it("picks the named variant, and makes the folder the category wants when the draft has none", async () => {
    const c = useGearList();
    c.startDraft();
    // a draft with no Sleep folder (the starter set has one; drop it)
    const sleep = c.snapshot.value!.folders.find((f) => f.colorKey === "sleep")!;
    c.removeFolder(sleep.id);
    expect(await packFromCatalog(c, "therm-a-rest/neoair-xlite-nxt", "Large")).toEqual({ ok: true, name: "Therm-a-Rest NeoAir XLite NXT Large" });
    const snap = c.snapshot.value!;
    const made = snap.folders.find((f) => f.name === "Sleep")!;
    expect(made.colorKey).toBe("sleep");
    expect(snap.items[0]).toMatchObject({ folderId: made.id, variant: "Large", unitWeightMg: 482_000, catalogItemId: 52 });
  });

  it("classifies food consumable and carries its calories", async () => {
    const c = useGearList();
    c.startDraft();
    expect((await packFromCatalog(c, "clif/bar")).ok).toBe(true);
    const snap = c.snapshot.value!;
    const food = snap.folders.find((f) => f.name === "Food & Fuel")!;
    expect(food.colorKey).toBe("consumable");
    expect(snap.items[0]).toMatchObject({ folderId: food.id, classification: "consumable", kcal: 250, catalogItemId: 61 });
  });

  it("reports a product the catalog doesn't have, and adds nothing", async () => {
    const c = useGearList();
    c.startDraft();
    expect(await packFromCatalog(c, "nobody/nothing")).toEqual({ ok: false });
    expect(c.snapshot.value!.items).toHaveLength(0);
    expect(created).toBeNull();
  });
});
