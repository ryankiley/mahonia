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
    const { data, isError, text } = await call("add_items", {
      edit_link: editLink,
      items: [
        { name: "Stakes", folder: "shelter", weight_g: 60, qty: 6 },
        { name: "Bars", folder: "Food", weight_g: 68, qty: 4, classification: "consumable", kcal: 250 },
      ],
    });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ added: 2, folders_made: ["Food"] });
    expect(data.totals).toMatchObject({ base_g: 1488, consumable_g: 272, total_g: 1760, item_count: 4, kcal: 1000 });
  });

  it("sets the trip's dates and trail", async () => {
    const { data, isError, text } = await call("set_trip", { edit_link: editLink, start_date: "2026-08-14", end_date: "2026-08-16", trail_url: "https://caltopo.com/m/ABC", trail_label: "Timberline", trail_distance_km: 64 });
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

    const md = await call("get_list_markdown", { share_code: shareCode });
    expect(md.text).toContain("# Timberline loop");
    expect(md.text).toContain("| Zpacks Duplex — Tent | 1 | 538 g |");
    expect(md.text).toContain("**Total:** 1,760 g");
  });

  it("searches the catalog and fetches one product's variants with their citations", async () => {
    const { data } = await call("search_catalog", { query: "revelation" });
    const results = data.results as { id: number; variant: string | null; weight_g: number }[];
    expect(results.map((r) => r.variant).sort()).toEqual(["20F Long", "20F Regular"]);

    const byId = await call("get_catalog_product", { id: results[0]!.id });
    expect(byId.data).toMatchObject({ brand: "Enlightened Equipment", name: "Revelation", gear_type: "Quilt" });
    expect((byId.data.variants as { variant: string; source_url: string }[]).map((v) => [v.variant, v.source_url])).toEqual([
      ["20F Long", "https://enlightenedequipment.com/revelation"],
      ["20F Regular", "https://enlightenedequipment.com/revelation"],
    ]);
    const byName = await call("get_catalog_product", { brand: "zpacks", name: "duplex" });
    expect(byName.data).toMatchObject({ brand: "Zpacks", name: "Duplex", variants: [{ variant: null, weight_g: 538, verified: true }] });
    expect((await call("get_catalog_product", { brand: "Nobody", name: "Duplex" })).isError).toBe(true);
  });
});

// Changing what is already there: the same list, now edited through its edit link the
// way an assistant asked to "move the stakes, rename the sleep folder, drop the bars"
// would edit it — read the ids with get_list, then the three edit tools. Each change
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
    const { data, isError, text } = await call("update_items", {
      edit_link: editLink,
      items: [
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
    const { data, isError, text } = await call("update_items", {
      edit_link: editLink,
      items: [
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
    const { isError, text } = await call("update_items", { edit_link: editLink, items: [{ id: row(before, "Revelation").id, qty: 2 }, { id: "nope", qty: 3 }] });
    expect(isError).toBe(true);
    expect(text).toContain('"nope"');
    expect(row(await read(), "Revelation").qty).toBe(1);
    expect((await call("remove_items", { edit_link: editLink, ids: ["nope"] })).isError).toBe(true);
    expect((await call("update_items", { edit_link: editLink, items: [{ id: row(before, "Revelation").id, name: "" }] })).isError).toBe(true);
    expect((await call("update_items", { edit_link: editLink, items: [{ id: row(before, "Revelation").id, carried_by: "Sam" }] })).text).toContain("names no people");
  });

  it("clears a field with null, and puts a row back to its folder's classification", async () => {
    const before = await read();
    const { isError, text } = await call("update_items", { edit_link: editLink, items: [{ id: row(before, "Stakes").id, note: null, classification: "worn" }] });
    expect(isError, text).toBe(false);
    expect(row(await read(), "Stakes")).toMatchObject({ classification: "worn" });
    expect(row(await read(), "Stakes").note).toBeUndefined();
    await call("update_items", { edit_link: editLink, items: [{ id: row(before, "Stakes").id, classification: null }] });
    expect(row(await read(), "Stakes").classification).toBe("base");
  });

  it("renames, reorders and removes folders, a removed folder taking its rows", async () => {
    const before = await read();
    const sleep = before.folders.find((f) => f.name === "Sleep")!;
    const { data, isError, text } = await call("update_folders", {
      edit_link: editLink,
      folders: [
        { folder: sleep.id, name: "Sleep system", position: 0 },
        { folder: "snacks", remove: true },
      ],
    });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ updated: 2, rows_removed: 1, folders: ["Sleep system", "Shelter", "Food"] });
    expect(layout(await read())).toEqual([["Sleep system", ["Revelation"]], ["Shelter", ["Stakes", "Duplex (2022)"]]]);
    const clash = await call("update_folders", { edit_link: editLink, folders: [{ folder: "Shelter", name: "sleep SYSTEM" }] });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain('"Sleep system"');
  });

  it("removes rows by id", async () => {
    const before = await read();
    const { data, isError, text } = await call("remove_items", { edit_link: editLink, ids: [row(before, "Stakes").id] });
    expect(isError, text).toBe(false);
    expect(data).toMatchObject({ removed: 1, totals: { item_count: 2 } });
    expect(layout(await read())).toEqual([["Sleep system", ["Revelation"]], ["Shelter", ["Duplex (2022)"]]]);
  });
});
