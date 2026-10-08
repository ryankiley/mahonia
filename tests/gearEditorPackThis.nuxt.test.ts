// @vitest-environment nuxt
//
// A catalog page's "Pack this" through the EDITOR, not the handler alone
// (tests/packFromCatalog.nuxt.test.ts covers that). /e?add=<slug> is a query on a
// page whose session watcher is keyed on the hash and the code, and that watcher's
// job is one session per ADDRESS — not one per navigation. The add watcher's first
// act is a same-page replace that clears the query, and Nuxt answers a same-page
// navigation by re-syncing its route object; a watcher that returned the (hash, code)
// pair as an array saw a fresh value on that sync and restarted the session mid-add —
// dispose() wrote the snapshot on screen over the on-device draft slot before the
// first restore had read it, and the row landed on a list that had just been thrown
// away and started again. Pinned here, against the real component and the real
// router: one epoch for the whole arrival, the query gone, the row in place.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { createError, readBody } from "h3";
import { stubLocalStorage } from "./helpers/storage";
import type { LocalListRecord } from "~~/shared/localList";
import type { ListSnapshot } from "~~/shared/types";
import GearEditor from "~/components/GearEditor.client.vue";

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

registerEndpoint("/api/catalog/product", (event) => {
  const slug = new URL(event.node.req.url ?? "", "http://x").searchParams.get("slug") ?? "";
  if (slug !== "durston/x-mid-2") throw createError({ statusCode: 404 });
  return {
    product: {
      brand: "Durston",
      name: "X-Mid 2",
      commonName: "Tent",
      categoryHint: "shelter",
      slug,
      variants: [{ id: 41, variant: null, weightMg: 887_000, weightSource: "manufacturer", sourceUrl: "https://durstongear.com/x", verified: true, kcal: null }],
    },
  };
});
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({}) });
registerEndpoint("/api/catalog/types", () => []);
registerEndpoint("/api/edit/changes", () => ({ version: 1 }));
let created: ListSnapshot | null = null;
registerEndpoint("/api/lists/create", {
  method: "POST",
  handler: async (event) => {
    const body = (await readBody(event)) as { title: string; data: { folders: ListSnapshot["folders"]; items: ListSnapshot["items"] } };
    created = { shareCode: "PACKC0DE0002", slug: "packed-bbb222", title: body.title || "Untitled list", description: "", displayUnit: "g", folders: body.data.folders, items: body.data.items, version: 1, isPublic: false };
    return { editToken: "packed-edit-token-2", snapshot: created };
  },
});

let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
  useGearList().dispose();
  records.clear();
  created = null;
});

describe("Pack this, arriving with the editor", () => {
  it("lands the row in the one session the address started, and clears the query", async () => {
    const router = useRouter();
    // Nuxt syncs the route object the editor reads only on a SAME-PAGE navigation
    // (a page swap syncs when the page renders, and no page renders here), so reach
    // the address in two hops: /e first, then /e with the query.
    await router.replace("/e");
    await router.replace({ path: "/e", query: { add: "durston/x-mid-2" } });
    expect(useRoute().query.add).toBe("durston/x-mid-2");

    const c = useGearList();
    wrapper = mount(GearEditor, { attachTo: document.body });
    // the session the address started — minted synchronously by the watcher at setup
    const epoch = c.epoch;
    expect(c.snapshot.value).not.toBeNull();

    await vi.waitFor(() => expect(c.snapshot.value?.items.map((i) => i.name)).toEqual(["X-Mid 2"]));
    expect(c.snapshot.value?.items[0]).toMatchObject({ brand: "Durston", catalogItemId: 41, unitWeightMg: 887_000 });
    // the query is gone (a reload can't add the row twice), and nothing else moved
    expect(useRoute().query.add).toBeUndefined();
    expect(useRoute().path).toBe("/e");
    // ONE session: the query-clearing replace did not tear it down and start over
    expect(c.epoch).toBe(epoch);
    // and the arrival tripped the draft's first save, like a first typed row does
    await vi.waitFor(() => expect(created).not.toBeNull());
    expect(created!.items.map((i) => i.name)).toEqual(["X-Mid 2"]);
  });
});
