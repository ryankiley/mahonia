import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import { ACCESS_TOKEN_PREFIX, mintAccessToken } from "../server/utils/accessTokens";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { CATALOG_DDL, proposeCorrection, revertEdit } from "../server/utils/catalog";
import { LISTS_DDL } from "../server/utils/db";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { catalogRow, seedCatalogRow } from "./helpers/catalog";
import { createTestDb, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";
import { makeEvent } from "./helpers/http";
import { expectResultConforms } from "./helpers/mcpSchema";

// verify_catalog_item, the one admin tool, driven through the real endpoint against a
// real (in-memory) database. Held here: only an account named in ADMIN_USER_IDS sees it
// in tools/list or can call it, and to everyone else it is a tool that doesn't exist; an
// admin's call verifies a row at once, stamped with the account, or adds a product the
// catalog lacks; and a call the audit would fail (a quote that doesn't state the weight,
// a weight out of range, a duplicate product) is refused with a sentence.

vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));
vi.mock("../server/utils/rateLimit", () => ({
  rateLimit: async () => {},
  rateLimitSubject: async () => {},
  useKv: () => ({ getItem: async () => null, setItem: async () => {} }),
}));
// the catalog reads pick their SQL by DATABASE_URL at call time
vi.stubEnv("DATABASE_URL", "");

const TOOL = "verify_catalog_item";
type ToolAnswer = { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean };
type Reply = { result?: ToolAnswer & { tools?: { name: string }[] }; error?: { code: number; message: string } | string };

async function post(body: unknown, token?: string) {
  const event = makeEvent("/mcp", { method: "POST", body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const reply = (await mcp(event)) as Reply;
  return { status: event.node.res.statusCode, reply };
}
const listed = async (token?: string) =>
  ((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token)).reply.result!.tools ?? []).map((t) => t.name);
const call = (args: unknown, token?: string) => post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: TOOL, arguments: args } }, token);
/** an admin's call that the tool answered: its row, or its refusal */
async function verify(args: Record<string, unknown>) {
  const { reply } = await call(args, adminWrite);
  const result = reply.result!;
  // the declared outputSchema, compiled closed, as every MCP suite holds its calls to
  expectResultConforms(TOOL, result);
  return { refused: result.isError ?? false, text: result.content[0]!.text, data: result.structuredContent as { created: boolean; row: Record<string, unknown> } };
}

let db: TestDb;
let admin = 0;
let otherId = 0;
let adminWrite = "";
let adminRead = "";
let otherWrite = "";
let duplex = 0;
let community = 0;
let retired = 0;
let merged = 0;
const NEVER_MINTED = `${ACCESS_TOKEN_PREFIX}this-was-never-minted`;
const DURSTON = "https://durstongear.com/products/x-mid-2";

beforeAll(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL, CATALOG_DDL);
  dbState.db = db;
  duplex = (await seedCatalogRow(db, { brand: "Zpacks", name: "Duplex", weightMg: 539_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/duplex", verified: true, commonName: "Tent", categoryHint: "shelter", searchTerms: "tent shelter" })).id;
  community = (await seedCatalogRow(db, { brand: "Durston", name: "X-Mid 2", weightMg: 1_000_000, commonName: "tent", categoryHint: "shelter", searchTerms: "tent" })).id;
  retired = (await seedCatalogRow(db, { brand: "Durston", name: "X-Mid 1", status: "removed" })).id;
  merged = (await seedCatalogRow(db, { brand: "Zpacks", name: "Duplex (2019)", status: "merged", mergedIntoId: duplex })).id;
  const [ryan, other] = (await db.insert(schema.users).values([{ email: "admin@example.com" }, { email: "other@example.com" }]).returning()).map((u) => u.id);
  admin = ryan!;
  otherId = other!;
  adminWrite = (await mintAccessToken(db, admin, { scope: "write", unproven: false }))!.token;
  adminRead = (await mintAccessToken(db, admin, { scope: "read", unproven: false }))!.token;
  otherWrite = (await mintAccessToken(db, other!, { scope: "write", unproven: false }))!.token;
  vi.stubEnv("ADMIN_USER_IDS", ` 999, ${admin} `);
});
afterEach(() => {
  vi.stubEnv("ADMIN_USER_IDS", ` 999, ${admin} `);
});

describe("who sees it and who can call it", () => {
  it("is listed as the public six plus itself, declared like them, and says it writes for everyone", async () => {
    const tools = (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, adminWrite)).reply.result!.tools as unknown as {
      name: string;
      outputSchema?: { type: string };
      annotations: Record<string, boolean>;
      inputSchema: { properties: Record<string, { type?: string; maxLength?: number; maximum?: number }> };
    }[];
    expect(tools.map((t) => t.name)).toEqual(["get_list", "search_catalog", "create_list", "edit_list", "get_my_gear", "edit_my_gear", TOOL]);
    const tool = tools.at(-1)!;
    expect(tool.outputSchema?.type).toBe("object");
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    // every free-text argument carries the cap the tool holds it to, as the other tools' do
    const uncapped = Object.entries(tool.inputSchema.properties).filter(([, p]) => p.type === "string" && !("enum" in p) && p.maxLength == null);
    expect(uncapped.map(([k]) => k)).toEqual([]);
    expect(tool.inputSchema.properties.weight_g!.maximum).toBe(100_000);
  });

  it("is listed for an admin's bearer only", async () => {
    expect(await listed(adminWrite)).toContain(TOOL);
    expect(await listed(adminRead)).toContain(TOOL);
    expect(await listed()).not.toContain(TOOL);
    expect(await listed(otherWrite)).not.toContain(TOOL);
    expect(await listed(NEVER_MINTED)).not.toContain(TOOL);
  });

  it("answers anyone but an admin as a tool that doesn't exist", async () => {
    for (const token of [undefined, otherWrite]) {
      const { status, reply } = await call({ catalog_id: community, weight_g: 1022, weight_source: "measured" }, token);
      expect(status).toBe(200);
      expect(reply.error).toEqual({ code: -32602, message: `Unknown tool: ${TOOL}` });
    }
    expect((await catalogRow(db, community)).verified).toBe(false);
  });

  it("asks only an admin's lapsed token to sign in again, and a read-only admin to reconnect", async () => {
    const lapsed = async (userId: number) => {
      const minted = (await mintAccessToken(db, userId, { scope: "write", unproven: false }))!;
      await db.update(schema.accessTokens).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.accessTokens.id, minted.id));
      return minted.token;
    };
    // the admin's client refreshes on the 401
    expect((await call({ catalog_id: community, weight_g: 1022 }, await lapsed(admin))).status).toBe(401);
    // a made-up bearer, or anyone else's lapsed one, learns nothing about the tool
    for (const token of [NEVER_MINTED, await lapsed(otherId)]) {
      const { status, reply } = await call({ catalog_id: community, weight_g: 1022 }, token);
      expect(status).toBe(200);
      expect(reply.error).toEqual({ code: -32602, message: `Unknown tool: ${TOOL}` });
    }
    expect((await call({ catalog_id: community, weight_g: 1022 }, adminRead)).status).toBe(403);
  });

  it("opens to nobody when ADMIN_USER_IDS is unset", async () => {
    vi.stubEnv("ADMIN_USER_IDS", "");
    expect(await listed(adminWrite)).not.toContain(TOOL);
    expect((await call({ catalog_id: community, weight_g: 1022, weight_source: "measured" }, adminWrite)).reply.error).toEqual({ code: -32602, message: `Unknown tool: ${TOOL}` });
  });
});

describe("verifying", () => {
  it("verifies a community row from the maker's page, stamped and in the edit history", async () => {
    const done = await verify({ catalog_id: community, weight_g: 1022, source_url: DURSTON, quote: "Total Weight: 36 oz / 1022 g", notes: "Checked the spec table" });
    expect(done.refused).toBe(false);
    expect(done.data).toMatchObject({ created: false, row: { id: community, weight_g: 1022, verified: true, weight_source: "manufacturer", source_url: DURSTON, gear_type: "Tent" } });
    expect(await catalogRow(db, community)).toMatchObject({ verified: true, verifiedBy: admin, sourceQuote: "Total Weight: 36 oz / 1022 g", commonName: "Tent" });
    const edits = await db.select().from(schema.catalogEdits).where(eq(schema.catalogEdits.catalogItemId, community));
    expect(edits.map((e) => [Number(e.oldWeightMg), Number(e.newWeightMg), e.reason, e.status])).toEqual([[1_000_000, 1_022_000, "Checked the spec table", "applied"]]);
  });

  it("takes a quote in ounces, and a pound-and-ounce figure as one weight", async () => {
    const row = await seedCatalogRow(db, { brand: "Gossamer Gear", name: "The Two", categoryHint: "shelter", weightMg: 700_000 });
    expect((await verify({ catalog_id: row.id, weight_g: 567, source_url: "https://gossamergear.com/the-two", quote: "Weight: 1 lb 4 oz" })).refused).toBe(false);
    expect((await verify({ catalog_id: row.id, weight_g: 652, source_url: "https://gossamergear.com/the-two", quote: "23 oz" })).refused).toBe(false);
  });

  it("takes the person's own scale weight with no link or quote", async () => {
    const row = await seedCatalogRow(db, { brand: "Toaks", name: "Titanium 750 Pot", categoryHint: "cook", weightMg: 90_000 });
    const done = await verify({ catalog_id: row.id, weight_g: 103, weight_source: "measured", notes: "Weighed on my scale" });
    expect(done.data.row).toMatchObject({ weight_g: 103, weight_source: "measured", verified: true });
    expect((await catalogRow(db, row.id)).verifiedBy).toBe(admin);
  });

  it("adds a product the catalog lacks, in the catalog's spelling of its brand and gear type", async () => {
    const done = await verify({ brand: "zpacks", name: "Altaplex", gear_type: "tent", weight_g: 440, source_url: "https://zpacks.com/altaplex", quote: "15.5 oz / 440 g" });
    expect(done.refused).toBe(false);
    expect(done.data).toMatchObject({ created: true, row: { brand: "Zpacks", name: "Altaplex", gear_type: "Tent", category: "shelter", weight_g: 440, verified: true } });
    const id = done.data.row.id as number;
    expect((await catalogRow(db, id)).verifiedBy).toBe(admin);
    const search = (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: { query: "altaplex" } } })).reply.result!;
    expect((search.structuredContent!.results as { id: number }[]).map((r) => r.id)).toContain(id);
  });

  it("keeps the row's link when a scale weight comes with none", async () => {
    const row = await seedCatalogRow(db, { brand: "Nitecore", name: "NU25", categoryHint: "electronics", weightMg: 45_000, sourceUrl: "https://flashlight.nitecore.com/nu25" });
    expect((await verify({ catalog_id: row.id, weight_g: 47, weight_source: "measured" })).refused).toBe(false);
    expect(await catalogRow(db, row.id)).toMatchObject({ sourceUrl: "https://flashlight.nitecore.com/nu25", weightSource: "measured", verifiedBy: admin });
  });

  it("reads the range and the category from a gear type that changes", async () => {
    // typed as a stuff sack (other, 4–1600 g), really a tent
    const row = await seedCatalogRow(db, { brand: "Tarptent", name: "Rainbow", commonName: "Stuff sack", categoryHint: "other", weightMg: 30_000 });
    expect((await verify({ catalog_id: row.id, gear_type: "Tent", weight_g: 1800, weight_source: "measured" })).refused).toBe(false);
    expect(await catalogRow(db, row.id)).toMatchObject({ commonName: "Tent", categoryHint: "shelter" });
  });

  it("brings a retired row back under its old id rather than refusing it", async () => {
    const done = await verify({ brand: "Durston", name: "X-Mid 1", gear_type: "Tent", weight_g: 790, weight_source: "measured" });
    expect(done.refused, done.text).toBe(false);
    expect(done.data).toMatchObject({ created: false, revived: true, row: { id: retired } });
    expect(await catalogRow(db, retired)).toMatchObject({ status: "active", verified: true, verifiedBy: admin });
  });

  it("refuses a new product that is already a row, or looks like one, and names it", async () => {
    const same = await verify({ brand: "Zpacks", name: "Duplex", gear_type: "Tent", weight_g: 539, weight_source: "measured" });
    expect(same.refused).toBe(true);
    expect(same.text).toContain(`catalog_id ${duplex}`);
    const near = await verify({ brand: "Zpacks", name: "Duplex Tent", gear_type: "Tent", weight_g: 539, weight_source: "measured" });
    expect(near.refused).toBe(true);
    expect(near.text).toContain(`catalog_id ${duplex}`);
  });
});

describe("what it refuses", () => {
  const refusal = async (args: Record<string, unknown>) => {
    const done = await verify(args);
    expect(done.refused, JSON.stringify(args)).toBe(true);
    return done.text;
  };

  it("refuses bad input with a sentence", async () => {
    const base = { catalog_id: community, weight_source: "measured" };
    expect(await refusal({ ...base, weight_g: 0 })).toContain("weight_g");
    expect(await refusal({ ...base, weight_g: 200_000 })).toContain("weight_g");
    expect(await refusal({ ...base, weight_g: "1022" })).toContain("weight_g");
    expect(await refusal({ ...base, weight_g: 1022, weight_source: "guessed" })).toContain("weight_source");
    expect(await refusal({ ...base, weight_g: 1022, source_url: "javascript:alert(1)" })).toContain("http");
    // a quote or a link past its cap is refused whole, never cut short of its figure
    expect(await refusal({ ...base, weight_g: 1022, source_url: `${DURSTON}?${"x".repeat(2000)}` })).toContain("source_url is at most");
    expect(await refusal({ catalog_id: community, weight_g: 1022, source_url: DURSTON, quote: `${"Specs. ".repeat(300)}1022 g` })).toContain("quote is at most");
    expect(await refusal({ ...base, weight_g: 1022, category: "spaceship" })).toContain("category");
    expect(await refusal({ catalog_id: community, weight_g: 1022, quote: "1022 g" })).toContain("source_url");
    expect(await refusal({ catalog_id: community, weight_g: 1022, source_url: DURSTON })).toContain("quote");
    expect(await refusal({ catalog_id: community, weight_g: 1022, source_url: DURSTON, quote: "Weight: 1,200 g" })).toContain("doesn't state 1022 g");
    expect(await refusal({ catalog_id: 3_000_000_000, weight_g: 1022, weight_source: "measured" })).toContain("catalog_id");
    expect(await refusal({ catalog_id: 999_999, weight_g: 1022, weight_source: "measured" })).toContain("No catalog row");
    expect(await refusal({ catalog_id: merged, weight_g: 539, weight_source: "measured" })).toContain(`retired into row ${duplex}`);
    expect(await refusal({ weight_g: 1022, weight_source: "measured" })).toContain("catalog_id");
    expect(await refusal({ name: "Mystery Thing", weight_g: 100, weight_source: "measured" })).toContain("gear_type");
  });

  it("leaves a research row to the research", async () => {
    expect(await refusal({ catalog_id: duplex, weight_g: 539, weight_source: "measured" })).toContain("seed/_research");
  });

  it("refuses a weight outside its kind of gear's range until the person confirms it", async () => {
    const row = await seedCatalogRow(db, { brand: "Six Moon Designs", name: "Lunar Solo", categoryHint: "shelter", weightMg: 740_000 });
    expect(await refusal({ catalog_id: row.id, weight_g: 50, weight_source: "measured" })).toContain("120–3500 g");
    expect((await verify({ catalog_id: row.id, weight_g: 50, weight_source: "measured", outside_range_ok: true })).refused).toBe(false);
    // a new product whose gear type names no kind of gear is held to "other"
    expect(await refusal({ brand: "Acme", name: "Gizmo", gear_type: "Gizmo", weight_g: 2000, weight_source: "measured" })).toContain("other");
  });
});

describe("undoing a verification, and corrections after one", () => {
  /** the newest applied edit on a row: what the admin feed's revert button names */
  const lastEdit = async (id: number) => {
    const edits = await db.select().from(schema.catalogEdits).where(eq(schema.catalogEdits.catalogItemId, id));
    return edits.filter((e) => e.status === "applied").sort((a, b) => b.id - a.id)[0]!;
  };

  it("puts the row back as it was, not the weight alone", async () => {
    const row = await seedCatalogRow(db, { brand: "Big Agnes", name: "Copper Spur UL1", commonName: "tent", categoryHint: "shelter", weightMg: 1_000_000, sourceUrl: "https://example.com/copper-spur" });
    await verify({ catalog_id: row.id, weight_g: 1020, source_url: "https://bigagnes.com/copper-spur-ul1", quote: "Packaged weight: 1020 g" });
    expect((await revertEdit(db, (await lastEdit(row.id)).id)).status).toBe("applied");
    expect(await catalogRow(db, row.id)).toMatchObject({
      weightMg: 1_000_000, verified: false, verifiedBy: null, weightSource: "community", sourceUrl: "https://example.com/copper-spur", sourceQuote: null, commonName: "tent",
    });
  });

  it("undoes a second verification back to the first", async () => {
    const row = await seedCatalogRow(db, { brand: "Thermarest", name: "NeoAir XLite NXT", categoryHint: "sleep", weightMg: 400_000 });
    await verify({ catalog_id: row.id, weight_g: 370, weight_source: "measured" });
    await verify({ catalog_id: row.id, weight_g: 354, source_url: "https://thermarest.com/xlite", quote: "Weight: 354 g" });
    await revertEdit(db, (await lastEdit(row.id)).id);
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 370_000, verified: true, verifiedBy: admin, weightSource: "measured", sourceQuote: null });
  });

  it("retires a product the verification added, and adding it again brings it back", async () => {
    const added = await verify({ brand: "Hyperlite", name: "Unbound 40", gear_type: "Backpack", weight_g: 850, weight_source: "measured" });
    const id = added.data.row.id as number;
    await revertEdit(db, (await lastEdit(id)).id);
    expect((await catalogRow(db, id)).status).toBe("removed");
    const again = await verify({ brand: "Hyperlite", name: "Unbound 40", gear_type: "Backpack", weight_g: 860, weight_source: "measured" });
    expect(again.data.row.id).toBe(id);
    expect((await catalogRow(db, id)).status).toBe("active");
  });

  it("won't undo a verification the seed has since taken over", async () => {
    const row = await seedCatalogRow(db, { brand: "Gossamer Gear", name: "Mariposa 60", categoryHint: "pack", weightMg: 900_000 });
    await verify({ catalog_id: row.id, weight_g: 940, weight_source: "measured" });
    // what upsertSeedRows does when the research names it
    await db.update(schema.catalogItems).set({ verifiedBy: null, sourceQuote: null, weightSource: "manufacturer" }).where(eq(schema.catalogItems.id, row.id));
    expect((await revertEdit(db, (await lastEdit(row.id)).id)).status).toBe("rejected");
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 940_000, verified: true, verifiedBy: null });
  });

  it("writes the row and its edit together or not at all", async () => {
    const row = await seedCatalogRow(db, { brand: "Sawyer", name: "Squeeze", categoryHint: "water", weightMg: 85_000 });
    // the row's update fails after the edit is written, as a dropped connection would
    await db.execute(sql`ALTER TABLE catalog_items ADD CONSTRAINT no_88 CHECK (weight_mg <> 88000)`);
    try {
      await call({ catalog_id: row.id, weight_g: 88, weight_source: "measured" }, adminWrite);
    } finally {
      await db.execute(sql`ALTER TABLE catalog_items DROP CONSTRAINT no_88`);
    }
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 85_000, verified: false, verifiedBy: null });
    expect(await db.select().from(schema.catalogEdits).where(eq(schema.catalogEdits.catalogItemId, row.id))).toEqual([]);
  });

  it("holds a cited correction to a verified-in-app row for review", async () => {
    const row = await seedCatalogRow(db, { brand: "REI", name: "Flash 22", categoryHint: "pack", weightMg: 400_000 });
    await verify({ catalog_id: row.id, weight_g: 420, weight_source: "measured" });
    const out = await proposeCorrection(db, { catalogItemId: row.id, newWeightMg: 380_000, sourceUrl: "https://www.rei.com/product/flash-22" });
    expect(out.status).toBe("proposed");
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 420_000, weightSource: "measured", verifiedBy: admin });
  });
});
