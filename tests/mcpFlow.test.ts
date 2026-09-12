import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent } from "h3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import { CATALOG_DDL } from "../server/utils/catalog";
import { LISTS_DDL, SNAPSHOTS_DDL, TRAIL_FAVICONS_DDL, _resetSnapshotEnsured } from "../server/utils/db";
import { createTestDb } from "./helpers/db";
import { stubFetch } from "./helpers/http";

// The MCP tools end to end against a real (in-memory) database: an assistant makes a
// list, adds to it, sets its trip, and reads it back the way a person would see it on
// the share page. mcp.test.ts pins the protocol with the repo stubbed; this is the half
// that proves the tools and the repo agree on what a list is.

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../server/utils/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../server/utils/db")>();
  const grab = async () => state.db;
  return { ...mod, useDb: grab, useCatalogDb: grab, useVaultDb: grab, useAccountDb: grab };
});
vi.mock("../server/utils/rateLimit", () => ({ rateLimit: async () => {} }));
// searchCatalog reads DATABASE_URL at call time to pick the Neon SQL branch, which a
// PGlite handle can't run; a shell with the variable exported must not turn this
// suite red for a reason that has nothing to do with the code
vi.stubEnv("DATABASE_URL", "");

async function rpc(method: string, params?: unknown, id = 1) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = "/mcp";
  const buf = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  req.headers = { host: "mahonia.test", "content-type": "application/json", "content-length": String(buf.length) };
  req.push(buf);
  req.push(null);
  const out = (await mcp(createEvent(req, new ServerResponse(req)))) as { result?: { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean } };
  return out.result!;
}
const call = async (name: string, args: unknown) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { data: r.structuredContent as Record<string, unknown>, text: r.content[0]!.text, isError: r.isError ?? false };
};

let editLink = "";
let shareCode = "";

beforeAll(async () => {
  // the trail favicon warm-up and nothing else reaches for the network; it tolerates a
  // dead one and writes a blank row, which is all this suite needs to know about it
  stubFetch(() => null);
  const db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL, TRAIL_FAVICONS_DDL, CATALOG_DDL);
  _resetSnapshotEnsured();
  await db.insert(schema.catalogItems).values([
    { brand: "Enlightened Equipment", name: "Revelation", variant: "20F Long", weightMg: 590_000, weightSource: "manufacturer", sourceUrl: "https://enlightenedequipment.com/revelation", verified: true, commonName: "Quilt", categoryHint: "sleep", searchTerms: "quilt sleep" },
    { brand: "Enlightened Equipment", name: "Revelation", variant: "20F Regular", weightMg: 550_000, weightSource: "manufacturer", sourceUrl: "https://enlightenedequipment.com/revelation", verified: true, commonName: "Quilt", categoryHint: "sleep", searchTerms: "quilt sleep" },
    { brand: "Zpacks", name: "Duplex", variant: null, weightMg: 538_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/duplex", verified: true, commonName: "Tent", categoryHint: "shelter", searchTerms: "tent shelter" },
  ]);
  state.db = db;
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
