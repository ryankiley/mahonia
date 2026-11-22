import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import { ACCESS_TOKEN_PREFIX, mintAccessToken } from "../server/utils/accessTokens";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { LISTS_DDL } from "../server/utils/db";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { catalogRow, seedCatalogRow } from "./helpers/catalog";
import { createTestDb, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";
import { makeEvent } from "./helpers/http";

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
  return { refused: result.isError ?? false, text: result.content[0]!.text, data: result.structuredContent as { created: boolean; row: Record<string, unknown> } };
}

let db: TestDb;
let admin = 0;
let adminWrite = "";
let adminRead = "";
let otherWrite = "";
let duplex = 0;
let community = 0;
let retired = 0;
const NEVER_MINTED = `${ACCESS_TOKEN_PREFIX}this-was-never-minted`;
const DURSTON = "https://durstongear.com/products/x-mid-2";

beforeAll(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL, CATALOG_DDL);
  dbState.db = db;
  duplex = (await seedCatalogRow(db, { brand: "Zpacks", name: "Duplex", weightMg: 539_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/duplex", verified: true, commonName: "Tent", categoryHint: "shelter", searchTerms: "tent shelter" })).id;
  community = (await seedCatalogRow(db, { brand: "Durston", name: "X-Mid 2", weightMg: 1_000_000, commonName: "tent", categoryHint: "shelter", searchTerms: "tent" })).id;
  retired = (await seedCatalogRow(db, { brand: "Durston", name: "X-Mid 1", status: "removed" })).id;
  const [ryan, other] = (await db.insert(schema.users).values([{ email: "admin@example.com" }, { email: "other@example.com" }]).returning()).map((u) => u.id);
  admin = ryan!;
  adminWrite = (await mintAccessToken(db, admin, { scope: "write", unproven: false }))!.token;
  adminRead = (await mintAccessToken(db, admin, { scope: "read", unproven: false }))!.token;
  otherWrite = (await mintAccessToken(db, other!, { scope: "write", unproven: false }))!.token;
  vi.stubEnv("ADMIN_USER_IDS", ` 999, ${admin} `);
});
afterEach(() => {
  vi.stubEnv("ADMIN_USER_IDS", ` 999, ${admin} `);
});

describe("who sees it and who can call it", () => {
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

  it("asks a dead bearer to sign in again, and a read-only admin to reconnect", async () => {
    expect((await call({ catalog_id: community, weight_g: 1022 }, NEVER_MINTED)).status).toBe(401);
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
    expect(await refusal({ ...base, weight_g: 1022, category: "spaceship" })).toContain("category");
    expect(await refusal({ catalog_id: community, weight_g: 1022, quote: "1022 g" })).toContain("source_url");
    expect(await refusal({ catalog_id: community, weight_g: 1022, source_url: DURSTON })).toContain("quote");
    expect(await refusal({ catalog_id: community, weight_g: 1022, source_url: DURSTON, quote: "Weight: 1,200 g" })).toContain("doesn't state 1022 g");
    expect(await refusal({ catalog_id: 3_000_000_000, weight_g: 1022, weight_source: "measured" })).toContain("catalog_id");
    expect(await refusal({ catalog_id: 999_999, weight_g: 1022, weight_source: "measured" })).toContain("No catalog row");
    expect(await refusal({ catalog_id: retired, weight_g: 1022, weight_source: "measured" })).toContain("retired");
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
