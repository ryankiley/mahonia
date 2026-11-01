import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import { CATALOG_DDL } from "../server/utils/catalog";
import { LISTS_DDL, SNAPSHOTS_DDL, TRAIL_FAVICONS_DDL } from "../server/utils/db";
import { createTestDb, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";
import { makeEvent, stubFetch } from "./helpers/http";
import { expectResultConforms } from "./helpers/mcpSchema";

// The MCP tools end to end against a real (in-memory) database: an assistant makes a
// list, adds to it, sets its trip, and reads it back the way a person would see it on
// the share page. mcp.test.ts pins the protocol with the repo stubbed; this is the half
// that proves the tools and the repo agree on what a list is.

vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));
vi.mock("../server/utils/rateLimit", () => {
  const kv = new Map<string, unknown>();
  return {
    rateLimit: async () => {},
    rateLimitSubject: async () => {},
    useKv: () => ({ getItem: async (k: string) => kv.get(k) ?? null, setItem: async (k: string, v: unknown) => void kv.set(k, v) }),
  };
});
// searchCatalog reads DATABASE_URL at call time to pick the Neon SQL branch, which a
// PGlite handle can't run; a shell with the variable exported must not turn this
// suite red for a reason that has nothing to do with the code
vi.stubEnv("DATABASE_URL", "");

async function rpc(method: string, params?: unknown, id = 1) {
  const event = makeEvent("/mcp", { method: "POST", body: { jsonrpc: "2.0", id, method, params } });
  const out = (await mcp(event)) as { result?: { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean } };
  return out.result!;
}
const call = async (name: string, args: unknown) => {
  const r = await rpc("tools/call", { name, arguments: args });
  // a real database's values, held to the declared shape as the stubbed suite's are
  expectResultConforms(name, r);
  return { data: r.structuredContent as Record<string, unknown>, text: r.content[0]!.text, isError: r.isError ?? false };
};

let editLink = "";
let shareCode = "";
let db: TestDb;

beforeAll(async () => {
  // the trail favicon warm-up and nothing else reaches for the network; it tolerates a
  // dead one and writes a blank row, which is all this suite needs to know about it
  stubFetch(() => null);
  db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL, TRAIL_FAVICONS_DDL, CATALOG_DDL);
  await db.insert(schema.catalogItems).values([
    { brand: "Enlightened Equipment", name: "Revelation", variant: "20F Long", weightMg: 590_000, weightSource: "manufacturer", sourceUrl: "https://enlightenedequipment.com/revelation", verified: true, commonName: "Quilt", categoryHint: "sleep", searchTerms: "quilt sleep" },
    { brand: "Enlightened Equipment", name: "Revelation", variant: "20F Regular", weightMg: 550_000, weightSource: "manufacturer", sourceUrl: "https://enlightenedequipment.com/revelation", verified: true, commonName: "Quilt", categoryHint: "sleep", searchTerms: "quilt sleep" },
    { brand: "Zpacks", name: "Duplex", variant: null, weightMg: 538_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/duplex", verified: true, commonName: "Tent", categoryHint: "shelter", searchTerms: "tent shelter" },
  ]);
  dbState.db = db;
});

describe("an assistant's session, start to finish", () => {
  it("makes a list with folders and rows, and gets both links back", async () => {
    const { data, isError, text } = await call("create_list", {
      title: "Timberline loop",
      folders: [
        // the tent by id alone: name, brand, gear type and the cited weight come from the catalog
        { name: "Shelter", items: [{ name: "duplex", catalog_id: 3 }] },
        // the quilt with a weight of its own, which stays
        { name: "Sleep", items: [{ name: "Revelation", brand: "Enlightened Equipment", variant: "20F Long", weight_g: 590, catalog_id: 1 }] },
      ],
    });
    expect(isError, text).toBe(false);
    expect(data.edit_link).toMatch(/^http:\/\/mahonia\.test\/e\/[0-9A-Z]{12}#[A-Za-z0-9_-]{40,}$/);
    expect(data.share_link).toMatch(/^http:\/\/mahonia\.test\/s\/[0-9A-Z]{12}$/);
    expect(data.totals).toMatchObject({ base_g: 1128, total_g: 1128, item_count: 2 });
    editLink = data.edit_link as string;
    shareCode = data.share_code as string;
  });

  it("adds rows through the edit link, into an existing folder and a new one", async () => {
    const { data, isError, text } = await call("edit_list", {
      edit_link: editLink,
      add: [
        { name: "Stakes", folder: "shelter", weight_g: 60, qty: 6 },
        { name: "Bars", folder: "Food", weight_g: 68, qty: 4, classification: "consumable", kcal: 250 },
      ],
    });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ added: 2, folders_made: ["Food"] });
    expect(data.totals).toMatchObject({ base_g: 1488, consumable_g: 272, total_g: 1760, item_count: 4, kcal: 1000 });
  });

  it("sets the trip's dates and trail", async () => {
    const { data, isError, text } = await call("edit_list", { edit_link: editLink, list: { start_date: "2026-08-14", end_date: "2026-08-16", trail_url: "https://caltopo.com/m/ABC", trail_label: "Timberline", trail_distance_km: 64 } });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ dates: { start: "2026-08-14", end: "2026-08-16" }, trail: { url: "https://caltopo.com/m/ABC", label: "Timberline", distance_m: 64_000 } });
  });

  it("reads the same list back by its share link, as data and as Markdown", async () => {
    const { data, isError } = await call("get_list", { share_code: `http://mahonia.test/s/${shareCode}` });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ title: "Timberline loop", dates: { start: "2026-08-14", end: "2026-08-16" }, totals: { total_g: 1760, kcal: 1000 } });
    const folders = data.folders as { name: string; items: Record<string, unknown>[] }[];
    expect(folders.map((f) => [f.name, f.items.length])).toEqual([["Shelter", 2], ["Sleep", 1], ["Food", 1]]);
    // the tent was given by id alone: its brand, name, gear type and weight are the catalog's
    expect(folders[0]!.items[0]).toMatchObject({ brand: "Zpacks", name: "Duplex", gear_type: "Tent", weight_g: 538, catalog_id: 3 });
    // the quilt was given a weight and no gear type: the weight is the caller's, the
    // gear type the catalog's, trickled down on read as the share page shows it
    expect(folders[1]!.items[0]).toMatchObject({ gear_type: "Quilt", variant: "20F Long", weight_g: 590 });
    expect(JSON.stringify(data)).not.toMatch(/routeGeometry|waypoints|packed|editToken/);

    const md = await call("get_list", { share_code: shareCode, format: "markdown" });
    expect(md.text).toContain("# Timberline loop");
    expect(md.text).toContain("| Zpacks Duplex — Tent | 1 | 538 g |");
    expect(md.text).toContain("**Total:** 1,760 g");
  });

  it("searches the catalog and fetches one product's variants with their citations", async () => {
    const { data } = await call("search_catalog", { query: "revelation" });
    const results = data.results as { id: number; variant: string | null; weight_g: number }[];
    expect(results.map((r) => r.variant).sort()).toEqual(["20F Long", "20F Regular"]);

    const byId = await call("search_catalog", { product_id: results[0]!.id });
    expect(byId.data).toMatchObject({ product: { brand: "Enlightened Equipment", name: "Revelation", gear_type: "Quilt" } });
    expect((byId.data.results as { variant: string; source_url: string }[]).map((v) => [v.variant, v.source_url])).toEqual([
      ["20F Long", "https://enlightenedequipment.com/revelation"],
      ["20F Regular", "https://enlightenedequipment.com/revelation"],
    ]);
    const byName = await call("search_catalog", { brand: "zpacks", name: "duplex" });
    expect(byName.data).toMatchObject({ product: { brand: "Zpacks", name: "Duplex" }, results: [{ variant: null, weight_g: 538, verified: true }] });
    expect((await call("search_catalog", { brand: "Nobody", name: "Duplex" })).isError).toBe(true);
  });
});

// Changing what is already there: the same list, now edited through its edit link the
// way an assistant asked to "move the stakes, rename the sleep folder, drop the bars"
// would edit it — read the ids with get_list, then edit_list, part by part. Each change
// is checked by reading the list back as a share reader sees it.
describe("an assistant changing a list it already made", () => {
  type Row = { id: string; name: string; qty: number; weight_g: number; note?: string; catalog_id?: number; classification: string };
  type Section = { id?: string; name: string; items: Row[] };
  const read = async () => (await call("get_list", { share_code: editLink })).data as { folders: Section[]; totals: Record<string, number> };
  const row = (list: { folders: Section[] }, name: string) => list.folders.flatMap((f) => f.items).find((r) => r.name === name)!;
  const layout = (list: { folders: Section[] }) => list.folders.map((f) => [f.name, f.items.map((r) => r.name)]);

  it("reads every row's and folder's id, from the edit link as well as the share link", async () => {
    const list = await read();
    expect(list.folders.every((f) => typeof f.id === "string")).toBe(true);
    expect(list.folders.flatMap((f) => f.items).every((r) => typeof r.id === "string")).toBe(true);
    expect(layout(list)).toEqual([["Shelter", ["Duplex", "Stakes"]], ["Sleep", ["Revelation"]], ["Food", ["Bars"]]]);
  });

  it("edits fields, keeping a catalog row's link while its typed weight and name are the owner's", async () => {
    const before = await read();
    const { data, isError, text } = await call("edit_list", {
      edit_link: editLink,
      update: [
        { id: row(before, "Stakes").id, qty: 8, note: "MSR Groundhog" },
        { id: row(before, "Duplex").id, name: "Duplex (2022)", weight_g: 545 },
      ],
    });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ updated: 2, folders_made: [] });
    const after = await read();
    expect(row(after, "Stakes")).toMatchObject({ qty: 8, note: "MSR Groundhog" });
    expect(row(after, "Duplex (2022)")).toMatchObject({ weight_g: 545, catalog_id: 3 });
    // the typed weight and name are marked as the owner's, so the catalog won't undo them
    const [stored] = await db.select().from(schema.lists);
    const tent = (stored!.data as { items: { name: string; weightOverridden?: boolean; nameOverridden?: boolean }[] }).items.find((i) => i.name === "Duplex (2022)");
    expect(tent).toMatchObject({ weightOverridden: true, nameOverridden: true });
  });

  it("moves a row into a folder it makes, and reorders rows within a folder", async () => {
    const before = await read();
    const { data, isError, text } = await call("edit_list", {
      edit_link: editLink,
      update: [
        { id: row(before, "Bars").id, folder: "Snacks" },
        { id: row(before, "Stakes").id, position: 0 },
      ],
    });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ updated: 2, folders_made: ["Snacks"] });
    // Food is left empty, and get_list leaves an empty folder out
    expect(layout(await read())).toEqual([["Shelter", ["Stakes", "Duplex (2022)"]], ["Sleep", ["Revelation"]], ["Snacks", ["Bars"]]]);
  });

  it("changes nothing when any row it names isn't there", async () => {
    const before = await read();
    const { isError, text } = await call("edit_list", { edit_link: editLink, update: [{ id: row(before, "Revelation").id, qty: 2 }, { id: "nope", qty: 3 }] });
    expect(isError).toBe(true);
    expect(text).toContain('"nope"');
    expect(row(await read(), "Revelation").qty).toBe(1);
    expect((await call("edit_list", { edit_link: editLink, remove: ["nope"] })).isError).toBe(true);
    expect((await call("edit_list", { edit_link: editLink, update: [{ id: row(before, "Revelation").id, name: "" }] })).isError).toBe(true);
    expect((await call("edit_list", { edit_link: editLink, update: [{ id: row(before, "Revelation").id, carried_by: "Sam" }] })).text).toContain("names no people");
    // one bad part fails the whole call: the good part beside it is not applied either
    expect((await call("edit_list", { edit_link: editLink, list: { title: "Half" }, remove: ["nope"] })).isError).toBe(true);
    expect(((await call("get_list", { share_code: editLink })).data as { title: string }).title).toBe("Timberline loop");
  });

  it("clears a field with null, and puts a row back to its folder's classification", async () => {
    const before = await read();
    const { isError, text } = await call("edit_list", { edit_link: editLink, update: [{ id: row(before, "Stakes").id, note: null, classification: "worn" }] });
    expect(isError, text).toBe(false);
    expect(row(await read(), "Stakes")).toMatchObject({ classification: "worn" });
    expect(row(await read(), "Stakes").note).toBeUndefined();
    await call("edit_list", { edit_link: editLink, update: [{ id: row(before, "Stakes").id, classification: null }] });
    expect(row(await read(), "Stakes").classification).toBe("base");
  });

  it("renames, reorders and removes folders, a removed folder taking its rows", async () => {
    const before = await read();
    const sleep = before.folders.find((f) => f.name === "Sleep")!;
    const { data, isError, text } = await call("edit_list", {
      edit_link: editLink,
      folders: [
        { folder: sleep.id, name: "Sleep system", position: 0 },
        { folder: "snacks", remove: true },
      ],
    });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ folders_changed: 2, removed: 1, folders: ["Sleep system", "Shelter", "Food"] });
    expect(layout(await read())).toEqual([["Sleep system", ["Revelation"]], ["Shelter", ["Stakes", "Duplex (2022)"]]]);
    const clash = await call("edit_list", { edit_link: editLink, folders: [{ folder: "Shelter", name: "sleep SYSTEM" }] });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain('"Sleep system"');
  });

  it("removes rows by id", async () => {
    const before = await read();
    const { data, isError, text } = await call("edit_list", { edit_link: editLink, remove: [row(before, "Stakes").id] });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ removed: 1, totals: { item_count: 2 } });
    expect(layout(await read())).toEqual([["Sleep system", ["Revelation"]], ["Shelter", ["Duplex (2022)"]]]);
  });
});

// Groups, one level deep as the site keeps them, and the catalog link, through the
// connector end to end: a list made with groups, rows put into and taken out of them,
// a group moved across folders with its rows, and a nested row relinked to the catalog
// without leaving its group, which is what a relink used to cost.
describe("groups and relinking, end to end", () => {
  type Row = { id: string; name: string; brand?: string; variant?: string; weight_g: number; catalog_id?: number; items?: Row[] };
  type Section = { name: string; items: Row[] };
  let link = "";
  let code = "";
  const read = async () => (await call("get_list", { share_code: code })).data as { folders: Section[]; totals: Record<string, number> };
  const find = (list: { folders: Section[] }, name: string): Row => {
    for (const f of list.folders) {
      for (const r of f.items) {
        if (r.name === name) return r;
        for (const k of r.items ?? []) if (k.name === name) return k;
      }
    }
    throw new Error(`no row called ${name}`);
  };
  const shape = (list: { folders: Section[] }) => list.folders.map((f) => [f.name, f.items.map((r) => (r.items ? [r.name, r.items.map((k) => k.name)] : r.name))]);

  it("create_list takes a group as a row with items, in its folder", async () => {
    const { data, isError, text } = await call("create_list", {
      title: "Wonderland",
      folders: [{ name: "Food", classification: "consumable", items: [{ name: "Monday", items: [{ name: "Bars", weight_g: 68, qty: 4 }, { name: "Jerky", weight_g: 50 }] }] }],
      items: [{ name: "Duplex", catalog_id: 3, items: [{ name: "Stakes", weight_g: 60, qty: 6 }] }],
    });
    expect(isError, text).toBe(false);
    link = data.edit_link as string;
    code = data.share_code as string;
    expect(data.totals).toMatchObject({ item_count: 5 });
    expect(shape(await read())).toEqual([["Food", [["Monday", ["Bars", "Jerky"]]]], ["Unfiled", [["Duplex", ["Stakes"]]]]]);
  });

  it("edit_list adds a row into a group, and refuses one that names a nested row or another folder", async () => {
    const monday = find(await read(), "Monday");
    const { data, isError, text } = await call("edit_list", { edit_link: link, add: [{ name: "Gummies", weight_g: 30, group: monday.id }] });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ added: 1, folders_made: [] });
    expect(shape(await read())[0]).toEqual(["Food", [["Monday", ["Bars", "Jerky", "Gummies"]]]]);
    const bars = find(await read(), "Bars");
    expect((await call("edit_list", { edit_link: link, add: [{ name: "x", group: bars.id }] })).text).toContain("itself nested");
    expect((await call("edit_list", { edit_link: link, add: [{ name: "x", group: monday.id, folder: "Shelter" }] })).text).toContain("another folder");
  });

  it("moves a row out of a group and back in to a place, and a group across folders with its rows", async () => {
    let list = await read();
    const monday = find(list, "Monday");
    const jerky = find(list, "Jerky");
    const out = await call("edit_list", { edit_link: link, update: [{ id: jerky.id, group: "" }] });
    expect(out.isError, out.text).toBe(false);
    expect(shape(await read())[0]).toEqual(["Food", [["Monday", ["Bars", "Gummies"]], "Jerky"]]);
    const back = await call("edit_list", { edit_link: link, update: [{ id: jerky.id, group: monday.id, position: 0 }] });
    expect(back.isError, back.text).toBe(false);
    expect(shape(await read())[0]).toEqual(["Food", [["Monday", ["Jerky", "Bars", "Gummies"]]]]);
    const moved = await call("edit_list", { edit_link: link, update: [{ id: monday.id, folder: "Day 1" }] });
    expect(moved.isError, moved.text).toBe(false);
    expect(moved.data.folders_made).toEqual(["Day 1"]);
    list = await read();
    expect(shape(list)).toEqual([["Day 1", [["Monday", ["Jerky", "Bars", "Gummies"]]]], ["Unfiled", [["Duplex", ["Stakes"]]]]]);
    expect((await call("edit_list", { edit_link: link, update: [{ id: monday.id, group: find(list, "Duplex").id }] })).text).toContain("rows nested under it");
  });

  it("relinks a nested row to the catalog where it sits, keeps a typed weight as the owner's, and unlinks", async () => {
    let list = await read();
    const gummies = find(list, "Gummies");
    const relinked = await call("edit_list", { edit_link: link, update: [{ id: gummies.id, catalog_id: 1 }] });
    expect(relinked.isError, relinked.text).toBe(false);
    list = await read();
    // the row is now the catalog's quilt, and still Monday's
    expect(shape(list)[0]).toEqual(["Day 1", [["Monday", ["Jerky", "Bars", "Revelation"]]]]);
    expect(find(list, "Revelation")).toMatchObject({ brand: "Enlightened Equipment", variant: "20F Long", weight_g: 590, catalog_id: 1 });
    // relinked again with a weight of its own: the catalog's variant, the owner's weight
    const quilt = find(list, "Revelation");
    const again = await call("edit_list", { edit_link: link, update: [{ id: quilt.id, catalog_id: 2, weight_g: 600 }] });
    expect(again.isError, again.text).toBe(false);
    expect(find(await read(), "Revelation")).toMatchObject({ variant: "20F Regular", weight_g: 600, catalog_id: 2 });
    const [stored] = await db.select().from(schema.lists).where(eq(schema.lists.shareCode, code));
    const kept = (stored!.data as { items: { id: string; weightOverridden?: boolean; catalogWeightMgAtLink?: number }[] }).items.find((i) => i.id === quilt.id)!;
    expect(kept).toMatchObject({ weightOverridden: true, catalogWeightMgAtLink: 550_000 });
    // unlinked: the row reads as it did, with no link
    await call("edit_list", { edit_link: link, update: [{ id: quilt.id, catalog_id: null }] });
    const after = find(await read(), "Revelation");
    expect(after).toMatchObject({ variant: "20F Regular", weight_g: 600 });
    expect(after.catalog_id).toBeUndefined();
    expect((await call("edit_list", { edit_link: link, update: [{ id: quilt.id, catalog_id: 404 }] })).text).toContain("isn't in the catalog");
  });

  it("removes a group with its rows", async () => {
    const monday = find(await read(), "Monday");
    const { data, isError, text } = await call("edit_list", { edit_link: link, remove: [monday.id] });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ removed: 4, totals: { item_count: 2 } });
    expect(shape(await read())).toEqual([["Unfiled", [["Duplex", ["Stakes"]]]]]);
  });
});
