// The product endpoint behind a catalog page's "Pack this": the slug is resolved
// through the bundled CSV, never a database column a reseed has to have written, and
// only the rows the page shows come back, so an unverified community size typed
// under the same product can't be the one a variant-less press adds.
import { beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../server/api/catalog/product.get";
import { makeEvent } from "./helpers/http";

const db = vi.hoisted(() => ({ productVariants: vi.fn() }));
vi.mock("../server/utils/catalog", () => db);
vi.mock("../server/utils/db", () => ({ useCatalogDb: async () => ({}) }));
vi.mock("../server/utils/rateLimit", () => ({ rateLimit: vi.fn(async () => {}) }));
vi.mock("../server/utils/catalogPages", () => ({
  catalogPages: async () =>
    new Map([
      ["big-agnes/sarvis-vst-2", { slug: "big-agnes/sarvis-vst-2", brand: "Big Agnes", name: "Sarvis VST 2", variants: [{ variant: "2P" }] }],
      ["durston/x-mid-2", { slug: "durston/x-mid-2", brand: "Durston", name: "X-Mid 2", variants: [{ variant: null }] }],
    ]),
}));

const row = (id: number, variant: string | null, verified = true) => ({ id, variant, weightMg: 1_000_000, weightSource: verified ? "manufacturer" : "community", sourceUrl: null, verified, kcal: null });
const ask = (slug: string) => handler(makeEvent(`/api/catalog/product?slug=${encodeURIComponent(slug)}`)) as Promise<{ product: { variants: { id: number }[] } }>;

beforeEach(() => db.productVariants.mockReset());

describe("/api/catalog/product", () => {
  it("resolves the slug through the CSV, by brand and name, and answers only the page's rows", async () => {
    db.productVariants.mockResolvedValue({ brand: "Big Agnes", name: "Sarvis VST 2", commonName: "Tent", categoryHint: "shelter", variants: [row(9, "1P", false), row(7, "2P")] });
    const { product } = await ask("big-agnes/sarvis-vst-2");
    expect(db.productVariants).toHaveBeenCalledWith(expect.anything(), { brand: "Big Agnes", name: "Sarvis VST 2" });
    expect(product.variants.map((v) => v.id)).toEqual([7]);
  });

  it("says no such product for a slug the CSV doesn't hold, or one the database hasn't caught up with", async () => {
    await expect(ask("nobody/nothing")).rejects.toMatchObject({ statusCode: 404 });
    await expect(ask("not a slug")).rejects.toMatchObject({ statusCode: 404 });
    expect(db.productVariants).not.toHaveBeenCalled();
    // a deploy ahead of its reseed: the page exists, its rows don't yet
    db.productVariants.mockResolvedValue(null);
    await expect(ask("durston/x-mid-2")).rejects.toMatchObject({ statusCode: 404 });
    db.productVariants.mockResolvedValue({ brand: "Durston", name: "X-Mid 2", commonName: null, categoryHint: null, variants: [row(3, "Solid")] });
    await expect(ask("durston/x-mid-2")).rejects.toMatchObject({ statusCode: 404 });
  });
});
