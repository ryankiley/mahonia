import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildSearchTerms } from "../scripts/searchTerms";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import { ACCESS_TOKEN_PREFIX, mintAccessToken } from "../server/utils/accessTokens";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { CATALOG_DDL, proposeCorrection } from "../server/utils/catalog";
import { LISTS_DDL } from "../server/utils/db";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { catalogRow, seedCatalogRow } from "./helpers/catalog";
import { createTestDb, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";
import { makeEvent } from "./helpers/http";

// The admin tools (verify_catalog_item, get_catalog_edits, revert_catalog_edit), driven
// through the real endpoint against a real (in-memory) database. Held here: only an
// account named in ADMIN_USER_IDS sees them in tools/list or can call them, and to
// everyone else they are tools that don't exist; an admin's call verifies a row at once,
// stamped with the account, or adds a product the catalog lacks; a call the audit would
// fail (a quote that doesn't state the weight, a weight out of range, a duplicate
// product) is refused with a sentence; and the edit history lists every change and
// undoes one by its id.

vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));
vi.mock("../server/utils/rateLimit", () => ({
  rateLimit: async () => {},
  rateLimitSubject: async () => {},
  useKv: () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
}));
// the catalog reads pick their SQL by DATABASE_URL at call time
vi.stubEnv("DATABASE_URL", "");

const TOOL = "verify_catalog_item";
const ADMIN_TOOLS = [TOOL, "get_catalog_edits", "revert_catalog_edit"];
type ToolAnswer = { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean };
type Reply = { result?: ToolAnswer & { tools?: { name: string }[] }; error?: { code: number; message: string } | string };

async function post(body: unknown, token?: string) {
  const event = makeEvent("/mcp", { method: "POST", body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const reply = (await mcp(event)) as Reply;
  return { status: event.node.res.statusCode, reply };
}
const listed = async (token?: string) =>
  ((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token)).reply.result!.tools ?? []).map((t) => t.name);
const callTool = (name: string, args: unknown, token?: string) => post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, token);
const call = (args: unknown, token?: string) => callTool(TOOL, args, token);
/** an admin's call to any admin tool that the tool answered */
async function adminCall(name: string, args: Record<string, unknown>, token = adminWrite): Promise<{ refused: boolean; text: string; data: any }> {
  const { reply } = await callTool(name, args, token);
  const result = reply.result!;
  return { refused: result.isError ?? false, text: result.content[0]!.text, data: result.structuredContent };
}
/** an admin's call that the tool answered: its row, or its refusal */
async function verify(args: Record<string, unknown>) {
  const { reply } = await call(args, adminWrite);
  const result = reply.result!;
  return { refused: result.isError ?? false, text: result.content[0]!.text, data: result.structuredContent as { created: boolean; row: Record<string, unknown>; edit_id: number; warnings?: string[] } };
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
  retired = (await seedCatalogRow(db, { brand: "Durston", name: "X-Mid 1", commonName: "Tent", categoryHint: "shelter", weightMg: 800_000, status: "removed" })).id;
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
  it("is listed as the public six plus the admin three, the writers saying they write for everyone", async () => {
    const tools = (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, adminWrite)).reply.result!.tools as unknown as {
      name: string;
      annotations: Record<string, boolean>;
      inputSchema: { properties: Record<string, { type?: string; maxLength?: number; maximum?: number }> };
    }[];
    expect(tools.map((t) => t.name)).toEqual(["get_list", "search_catalog", "create_list", "edit_list", "get_my_gear", "edit_my_gear", ...ADMIN_TOOLS]);
    const [verifyTool, editsTool, revertTool] = tools.slice(-3) as [(typeof tools)[0], (typeof tools)[0], (typeof tools)[0]];
    for (const tool of [verifyTool, editsTool, revertTool]) {
      // every free-text argument carries the cap the tool holds it to, as the other tools' do
      const uncapped = Object.entries(tool.inputSchema.properties).filter(([, p]) => p.type === "string" && !("enum" in p) && p.maxLength == null);
      expect(uncapped.map(([k]) => k), tool.name).toEqual([]);
    }
    const writesForEveryone = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
    expect(verifyTool.annotations).toEqual(writesForEveryone);
    expect(revertTool.annotations).toEqual(writesForEveryone);
    expect(editsTool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(verifyTool.inputSchema.properties.weight_g!.maximum).toBe(100_000);
  });

  it("is listed for an admin's bearer only", async () => {
    expect(await listed(adminWrite)).toEqual(expect.arrayContaining(ADMIN_TOOLS));
    expect(await listed(adminRead)).toEqual(expect.arrayContaining(ADMIN_TOOLS));
    for (const token of [undefined, otherWrite, NEVER_MINTED]) {
      expect((await listed(token)).filter((name) => ADMIN_TOOLS.includes(name))).toEqual([]);
    }
  });

  it("answers a signed-in account that isn't an admin as a tool that doesn't exist, and asks anyone else to sign in", async () => {
    const calls: [string, Record<string, unknown>][] = [
      [TOOL, { catalog_id: community, weight_g: 1022, weight_source: "measured" }],
      ["get_catalog_edits", {}],
      ["revert_catalog_edit", { edit_id: 1 }],
    ];
    for (const [name, args] of calls) {
      const { status, reply } = await callTool(name, args, otherWrite);
      expect(status).toBe(200);
      expect(reply.error).toEqual({ code: -32602, message: `Unknown tool: ${name}` });
      // the names are in the public source; a call with no sign-in is asked for one
      expect((await callTool(name, args)).status).toBe(401);
    }
    expect((await catalogRow(db, community)).verified).toBe(false);
  });

  it("asks a lapsed or made-up token to sign in again, and a read-only admin to reconnect", async () => {
    const lapsed = async (userId: number) => {
      const minted = (await mintAccessToken(db, userId, { scope: "write", unproven: false }))!;
      await db.update(schema.accessTokens).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.accessTokens.id, minted.id));
      return minted.token;
    };
    // a client refreshes on the 401, and a token that opens nothing writes nothing
    for (const token of [await lapsed(admin), NEVER_MINTED, await lapsed(otherId)]) {
      expect((await call({ catalog_id: community, weight_g: 1022 }, token)).status).toBe(401);
    }
    expect((await catalogRow(db, community)).verified).toBe(false);
    expect((await call({ catalog_id: community, weight_g: 1022 }, adminRead)).status).toBe(403);
    // a read-only admin connection reads the history but can't undo anything in it
    expect((await adminCall("get_catalog_edits", {}, adminRead)).refused).toBe(false);
    expect((await callTool("revert_catalog_edit", { edit_id: 1 }, adminRead)).status).toBe(403);
  });

  it("opens to nobody when ADMIN_USER_IDS is unset", async () => {
    vi.stubEnv("ADMIN_USER_IDS", "");
    expect((await listed(adminWrite)).filter((name) => ADMIN_TOOLS.includes(name))).toEqual([]);
    expect((await call({ catalog_id: community, weight_g: 1022, weight_source: "measured" }, adminWrite)).reply.error).toEqual({ code: -32602, message: `Unknown tool: ${TOOL}` });
  });
});

describe("verifying", () => {
  it("verifies a community row from the maker's page, stamped and in the edit history", async () => {
    const done = await verify({ catalog_id: community, weight_g: 1022, source_url: DURSTON, quote: "Total Weight: 36 oz / 1022 g", notes: "Checked the spec table" });
    expect(done.refused).toBe(false);
    expect(done.data).toMatchObject({ created: false, row: { id: community, weight_g: 1022, verified: true, weight_source: "manufacturer", source_url: DURSTON, gear_type: "Tent" } });
    expect(await catalogRow(db, community)).toMatchObject({ verified: true, verifiedBy: admin, sourceQuote: "Total Weight: 36 oz / 1022 g", commonName: "Tent" });
    // found by the words the build would give it, not by its gear type alone
    const terms = (await catalogRow(db, community)).searchTerms;
    expect(terms).toBe(buildSearchTerms("X-Mid 2", "shelter", "Tent"));
    expect(terms).toContain("shelter");
    const edits = await db.select().from(schema.catalogEdits).where(eq(schema.catalogEdits.catalogItemId, community));
    expect(edits.map((e) => [Number(e.oldWeightMg), Number(e.newWeightMg), e.reason, e.status])).toEqual([[1_000_000, 1_022_000, "Checked the spec table", "applied"]]);
    // the answer names that edit, for revert_catalog_edit
    expect(done.data.edit_id).toBe(edits[0]!.id);
  });

  it("takes a quote in ounces, and a pound-and-ounce figure as one weight", async () => {
    const row = await seedCatalogRow(db, { brand: "Gossamer Gear", name: "The Two", commonName: "Tent", categoryHint: "shelter", weightMg: 700_000 });
    expect((await verify({ catalog_id: row.id, weight_g: 567, source_url: "https://gossamergear.com/the-two", quote: "Weight: 1 lb 4 oz" })).refused).toBe(false);
    expect((await verify({ catalog_id: row.id, weight_g: 652, source_url: "https://gossamergear.com/the-two", quote: "23 oz" })).refused).toBe(false);
  });

  it("takes the person's own scale weight with no link or quote", async () => {
    const row = await seedCatalogRow(db, { brand: "Toaks", name: "Titanium 750 Pot", commonName: "Pot", categoryHint: "cook", weightMg: 90_000 });
    const done = await verify({ catalog_id: row.id, weight_g: 103, weight_source: "measured", notes: "Weighed on my scale" });
    expect(done.data.row).toMatchObject({ weight_g: 103, weight_source: "measured", verified: true });
    expect((await catalogRow(db, row.id)).verifiedBy).toBe(admin);
  });

  it("adds a product the catalog lacks, in the catalog's spelling of its brand and gear type", async () => {
    const done = await verify({ brand: "zpacks", name: "Altaplex", gear_type: "tent", weight_g: 440, source_url: "https://zpacks.com/altaplex", quote: "15.5 oz / 440 g" });
    expect(done.refused).toBe(false);
    expect(done.data).toMatchObject({ created: true, row: { brand: "Zpacks", name: "Altaplex", gear_type: "Tent", category: "shelter", weight_g: 440, verified: true } });
    const id = done.data.row.id as number;
    const [edit] = await db.select().from(schema.catalogEdits).where(eq(schema.catalogEdits.catalogItemId, id));
    expect(done.data.edit_id).toBe(edit!.id);
    expect(await catalogRow(db, id)).toMatchObject({ verifiedBy: admin, searchTerms: buildSearchTerms("Altaplex", "shelter", "Tent") });
    expect((await catalogRow(db, id)).searchTerms).toContain("shelter");
    const search = (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: { query: "altaplex" } } })).reply.result!;
    expect((search.structuredContent!.results as { id: number }[]).map((r) => r.id)).toContain(id);
  });

  it("keeps the row's link when a scale weight comes with none", async () => {
    const row = await seedCatalogRow(db, { brand: "Nitecore", name: "NU25", commonName: "Headlamp", categoryHint: "electronics", weightMg: 45_000, sourceUrl: "https://flashlight.nitecore.com/nu25" });
    expect((await verify({ catalog_id: row.id, weight_g: 47, weight_source: "measured" })).refused).toBe(false);
    expect(await catalogRow(db, row.id)).toMatchObject({ sourceUrl: "https://flashlight.nitecore.com/nu25", weightSource: "measured", verifiedBy: admin });
  });

  it("reads the range and the category from a gear type that changes", async () => {
    // typed as a stuff sack (other, 4–1600 g), really a tent
    const row = await seedCatalogRow(db, { brand: "Tarptent", name: "Rainbow", commonName: "Stuff sack", categoryHint: "other", weightMg: 30_000 });
    // 30 g to 1800 g is far from what the row weighed: it waits for the person's word
    expect((await verify({ catalog_id: row.id, gear_type: "Tent", weight_g: 1800, weight_source: "measured" })).text).toContain("weight_confirmed");
    expect((await verify({ catalog_id: row.id, gear_type: "Tent", weight_g: 1800, weight_source: "measured", weight_confirmed: true })).refused).toBe(false);
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

  it("leaves a research row's name and gear type to the research, and a scale weight to My Gear", async () => {
    expect(await refusal({ catalog_id: duplex, weight_g: 539, weight_source: "measured" })).toContain("edit_my_gear's weight_g");
    const cite = { catalog_id: duplex, weight_g: 539, source_url: "https://zpacks.com/duplex", quote: "Weight 19.0 oz / 539 g" };
    expect(await refusal({ ...cite, name: "Duplex Classic" })).toContain("seed/_research");
    expect(await refusal({ ...cite, variant: "Olive" })).toContain("seed/_research");
    expect(await refusal({ ...cite, gear_type: "Tarp" })).toContain("seed/_research");
    expect(await refusal({ ...cite, category: "other" })).toContain("seed/_research");
    expect(await catalogRow(db, duplex)).toMatchObject({ verifiedBy: null, sourceQuote: null });
  });

  it("corrects a research row's weight from the maker's page, keeps it the research's after, and the undo hands it back", async () => {
    const montbell = "https://www.montbell.com/us/en/products/detail/2301381";
    const built = buildSearchTerms("Plasma 1000 Down Jacket", "clothing", "Down jacket");
    const row = await seedCatalogRow(db, { brand: "Montbell", name: "Plasma 1000 Down Jacket", variant: "Men's Medium", commonName: "Down jacket", categoryHint: "clothing", searchTerms: built, weightMg: 136_078, weightSource: "manufacturer", sourceUrl: montbell, verified: true });
    // it graduates back into its own research file, where the audit reads the quote's grams
    // alone: an ounce figure doesn't carry it past a gram figure that disagrees
    const ounces = await refusal({ catalog_id: row.id, weight_g: 139, source_url: montbell, quote: "Average Weight 4.9 oz, fill weight 50 g" });
    expect(ounces).toContain("nearest quote figure 50 g");
    expect(ounces).toContain("quote its line");
    const first = await verify({ catalog_id: row.id, weight_g: 138, source_url: montbell, quote: "Average Weight 138g" });
    expect(first.refused, first.text).toBe(false);
    // stamped like any verification; the gear type, kind and search terms stay the build's
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 138_000, verifiedBy: admin, sourceQuote: "Average Weight 138g", commonName: "Down jacket", categoryHint: "clothing", searchTerms: built });
    // stamped, it's still the research's to rename or retype, and still the maker's figure
    const cite = { catalog_id: row.id, weight_g: 138, source_url: montbell, quote: "Average Weight 138g" };
    expect(await refusal({ ...cite, name: "Plasma 1000 Down Parka" })).toContain("seed/_research");
    expect(await refusal({ ...cite, gear_type: "Insulated jacket" })).toContain("seed/_research");
    expect(await refusal({ catalog_id: row.id, weight_g: 141, weight_source: "measured" })).toContain("edit_my_gear's weight_g");
    // and its quote is still read as its research file reads it, with nothing else changing
    expect(await refusal({ catalog_id: row.id, weight_g: 139, source_url: montbell, quote: "Average Weight 4.9 oz, fill weight 50 g" })).toContain("nearest quote figure 50 g");
    // a second correction naming the row's own gear type leaves it, and the search terms, be
    const second = await verify({ ...cite, gear_type: "down jacket", weight_g: 139, quote: "Average Weight 139g" });
    expect(second.refused, second.text).toBe(false);
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 139_000, commonName: "Down jacket", searchTerms: built });
    // undone, newest first, it is the research's again with the research's weight
    expect((await adminCall("revert_catalog_edit", { edit_id: second.data.edit_id })).refused).toBe(false);
    expect((await adminCall("revert_catalog_edit", { edit_id: first.data.edit_id })).refused).toBe(false);
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 136_078, verified: true, verifiedBy: null, sourceQuote: null, sourceUrl: montbell });
  });

  it("refuses a weight outside its kind of gear's range until the person confirms it", async () => {
    const row = await seedCatalogRow(db, { brand: "Six Moon Designs", name: "Lunar Solo", commonName: "Tent", categoryHint: "shelter", weightMg: 740_000 });
    expect(await refusal({ catalog_id: row.id, weight_g: 50, weight_source: "measured" })).toContain("120–3500 g");
    expect((await verify({ catalog_id: row.id, weight_g: 50, weight_source: "measured", weight_confirmed: true })).refused).toBe(false);
    // a new product whose gear type names no kind of gear is held to "other"
    expect(await refusal({ brand: "Acme", name: "Gizmo", gear_type: "Gizmo", weight_g: 2000, weight_source: "measured" })).toContain("other");
  });
});

describe("the edit history, undoing a verification, and corrections after one", () => {
  const revert = (edit_id: number) => adminCall("revert_catalog_edit", { edit_id });

  it("puts the row back as it was, not the weight alone", async () => {
    const row = await seedCatalogRow(db, { brand: "Big Agnes", name: "Copper Spur UL1", commonName: "tent", categoryHint: "shelter", weightMg: 1_000_000, sourceUrl: "https://example.com/copper-spur" });
    const done = await verify({ catalog_id: row.id, weight_g: 1020, source_url: "https://bigagnes.com/copper-spur-ul1", quote: "Packaged weight: 1020 g" });
    const undone = await revert(done.data.edit_id);
    expect(undone.refused, undone.text).toBe(false);
    expect(undone.data).toMatchObject({ edit_id: done.data.edit_id, retired: false, row: { id: row.id, weight_g: 1000, verified: false } });
    expect(await catalogRow(db, row.id)).toMatchObject({
      weightMg: 1_000_000, verified: false, verifiedBy: null, weightSource: "community", sourceUrl: "https://example.com/copper-spur", sourceQuote: null, commonName: "tent",
    });
  });

  it("undoes a second verification back to the first", async () => {
    const row = await seedCatalogRow(db, { brand: "Thermarest", name: "NeoAir XLite NXT", commonName: "Sleeping pad", categoryHint: "sleep", weightMg: 400_000 });
    const first = await verify({ catalog_id: row.id, weight_g: 370, weight_source: "measured" });
    const second = await verify({ catalog_id: row.id, weight_g: 354, source_url: "https://thermarest.com/xlite", quote: "Weight: 354 g" });
    // the older one can't go first: it would throw the newer one away unseen
    expect((await revert(first.data.edit_id)).text).toContain(`newer applied edit, ${second.data.edit_id}`);
    expect((await revert(second.data.edit_id)).refused).toBe(false);
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 370_000, verified: true, verifiedBy: admin, weightSource: "measured", sourceQuote: "Weighed on an admin's scale: 370 g" });
  });

  it("retires a product the verification added, and adding it again brings it back", async () => {
    const added = await verify({ brand: "Hyperlite", name: "Unbound 40", gear_type: "Backpack", weight_g: 850, weight_source: "measured" });
    const id = added.data.row.id as number;
    expect((await revert(added.data.edit_id)).data.retired).toBe(true);
    expect((await catalogRow(db, id)).status).toBe("removed");
    const again = await verify({ brand: "Hyperlite", name: "Unbound 40", gear_type: "Backpack", weight_g: 860, weight_source: "measured" });
    expect(again.data.row.id).toBe(id);
    expect((await catalogRow(db, id)).status).toBe("active");
  });

  it("won't undo a verification or a correction the seed has since taken over", async () => {
    const row = await seedCatalogRow(db, { brand: "Gossamer Gear", name: "Mariposa 60", commonName: "Backpack", categoryHint: "pack", weightMg: 900_000 });
    const done = await verify({ catalog_id: row.id, weight_g: 940, weight_source: "measured" });
    // what upsertSeedRows does when the research names it
    await db.update(schema.catalogItems).set({ verifiedBy: null, sourceQuote: null, weightSource: "manufacturer" }).where(eq(schema.catalogItems.id, row.id));
    expect((await revert(done.data.edit_id)).text).toContain("seed/_research");
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 940_000, verified: true, verifiedBy: null });
    // a community correction keeps no snapshot: the research's weight since is what stops it
    const kumo = await seedCatalogRow(db, { brand: "Gossamer Gear", name: "Kumo 36", commonName: "Backpack", categoryHint: "pack", weightMg: 600_000 });
    await proposeCorrection(db, { catalogItemId: kumo.id, newWeightMg: 650_000 });
    const [fix] = (await adminCall("get_catalog_edits", { catalog_id: kumo.id })).data.edits;
    await db.update(schema.catalogItems).set({ weightMg: 620_000, verified: true, weightSource: "manufacturer" }).where(eq(schema.catalogItems.id, kumo.id));
    expect((await revert(fix.id)).text).toContain("has changed since");
    expect(await catalogRow(db, kumo.id)).toMatchObject({ weightMg: 620_000, verified: true });
  });

  it("turns down a suggested fix that waits for review, leaving the row as it was", async () => {
    const row = await seedCatalogRow(db, { brand: "Nemo", name: "Moonlite Elite", commonName: "Camp chair", categoryHint: "other", weightMg: 552_000, weightSource: "manufacturer", verified: true });
    // a verified row takes an uncited fix as proposed: it waits, and the weight stays
    expect((await proposeCorrection(db, { catalogItemId: row.id, newWeightMg: 656_000 })).status).toBe("proposed");
    const [fix] = (await adminCall("get_catalog_edits", { catalog_id: row.id })).data.edits;
    expect(fix.status).toBe("proposed");
    const done = await revert(fix.id);
    expect(done.refused, done.text).toBe(false);
    expect(done.data).toMatchObject({ edit_id: fix.id, rejected: true, retired: false, row: { id: row.id, weight_g: 552 } });
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 552_000, verified: true, weightSource: "manufacturer" });
    expect((await adminCall("get_catalog_edits", { catalog_id: row.id })).data.edits[0].status).toBe("rejected");
    expect((await revert(fix.id)).text).toContain("already turned down");
    // a fix to a row since gone from the catalog is turned down all the same, with no row to show
    const gone = await seedCatalogRow(db, { brand: "Nemo", name: "Moonlite", commonName: "Camp chair", categoryHint: "other", weightMg: 850_000, weightSource: "manufacturer", verified: true });
    await proposeCorrection(db, { catalogItemId: gone.id, newWeightMg: 900_000 });
    const [goneFix] = (await adminCall("get_catalog_edits", { catalog_id: gone.id })).data.edits;
    await db.delete(schema.catalogItems).where(eq(schema.catalogItems.id, gone.id));
    expect((await revert(goneFix.id)).data).toEqual({ edit_id: goneFix.id, rejected: true, retired: true, row: null });
  });

  it("refuses an edit that isn't there, or is already undone", async () => {
    expect((await revert(999_999)).text).toContain("No catalog edit has id 999999");
    const row = await seedCatalogRow(db, { brand: "Petzl", name: "Bindi", commonName: "Headlamp", categoryHint: "electronics", weightMg: 40_000 });
    const done = await verify({ catalog_id: row.id, weight_g: 35, weight_source: "measured" });
    expect((await revert(done.data.edit_id)).refused).toBe(false);
    expect((await revert(done.data.edit_id)).text).toContain("already undone");
  });

  it("lists the edit history newest first, one row's or every row's, and undoes a suggested fix", async () => {
    const row = await seedCatalogRow(db, { brand: "Nemo", name: "Tensor", commonName: "Sleeping pad", categoryHint: "sleep", weightMg: 500_000 });
    // a community row: an uncited fix applies at once
    await proposeCorrection(db, { catalogItemId: row.id, newWeightMg: 450_000, reason: "my scale says 450" });
    const done = await verify({ catalog_id: row.id, weight_g: 425, weight_source: "measured" });
    const history = await adminCall("get_catalog_edits", { catalog_id: row.id });
    expect(history.data.edits.map((c: Record<string, unknown>) => [c.kind, c.status, c.old_weight_g, c.new_weight_g, c.catalog_id])).toEqual([
      ["verification", "applied", 450, 425, row.id],
      ["correction", "applied", 500, 450, row.id],
    ]);
    expect(history.data.edits[0].id).toBe(done.data.edit_id);
    expect(history.data.edits[1].reason).toBe("my scale says 450");
    expect((await adminCall("get_catalog_edits", { limit: 1 })).data.edits).toHaveLength(1);
    expect((await adminCall("get_catalog_edits", { limit: 0 })).text).toContain("limit");
    // the fix sits under the verification; undo that first, then the fix itself
    const fix = history.data.edits[1].id as number;
    expect((await revert(fix)).refused).toBe(true);
    await revert(done.data.edit_id);
    expect((await revert(fix)).data.row).toMatchObject({ id: row.id, weight_g: 500 });
    const after = await adminCall("get_catalog_edits", { catalog_id: row.id });
    expect(after.data.edits.map((c: Record<string, unknown>) => c.status)).toEqual(["reverted", "reverted"]);
  });

  it("writes the row and its edit together or not at all", async () => {
    const row = await seedCatalogRow(db, { brand: "Sawyer", name: "Squeeze", commonName: "Water filter", categoryHint: "water", weightMg: 85_000 });
    // the row's update fails after the edit is written, as a dropped connection would
    await db.execute(sql`ALTER TABLE catalog_items ADD CONSTRAINT no_88 CHECK (weight_mg <> 88000)`);
    try {
      const { reply } = await call({ catalog_id: row.id, weight_g: 88, weight_source: "measured" }, adminWrite);
      // the write itself failed, not a check before it
      expect(reply.result?.isError ?? true).toBe(true);
      expect(reply.result?.content[0]?.text ?? "").not.toMatch(/house style|weight_confirmed|outside/);
    } finally {
      await db.execute(sql`ALTER TABLE catalog_items DROP CONSTRAINT no_88`);
    }
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 85_000, verified: false, verifiedBy: null });
    expect(await db.select().from(schema.catalogEdits).where(eq(schema.catalogEdits.catalogItemId, row.id))).toEqual([]);
  });

  it("holds a cited correction to a verified-in-app row for review", async () => {
    const row = await seedCatalogRow(db, { brand: "REI", name: "Flash 22", commonName: "Backpack", categoryHint: "pack", weightMg: 400_000 });
    await verify({ catalog_id: row.id, weight_g: 420, weight_source: "measured" });
    const out = await proposeCorrection(db, { catalogItemId: row.id, newWeightMg: 380_000, sourceUrl: "https://www.rei.com/product/flash-22" });
    expect(out.status).toBe("proposed");
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 420_000, weightSource: "measured", verifiedBy: admin });
  });
});

describe("the rules a chat doesn't have to be told", () => {
  it("holds a new row to the catalog's house style, in the audit's own words", async () => {
    const colour = await verify({ brand: "Norda", name: "Luster Cap", variant: "Stone, Large", gear_type: "Hat", weight_g: 36, weight_source: "measured" });
    expect(colour.refused).toBe(true);
    // the colour word is named, so the size beside it isn't read as refused too
    expect(colour.text).toContain('"Stone" in variant');
    const edition = await verify({ brand: "Norda", name: "Luster Cap", variant: "Trail Team Edition", gear_type: "Hat", weight_g: 36, weight_source: "measured" });
    expect(edition.refused).toBe(true);
    expect(edition.text).toContain("an edition isn't a size");
    const repeated = await verify({ brand: "Goldwin", name: "Goldwin 0 3L Jacket", variant: "JP 4", gear_type: "Rain jacket", weight_g: 300, weight_source: "measured" });
    expect(repeated.text).toContain("name starts with the brand");
    // rules that read the whole catalog, not one product: a variant token spelled as no
    // other row spells it, and a gear type filed under another kind than every row of it
    await seedCatalogRow(db, { brand: "Garmin", name: "fēnix 8", variant: "47mm, Stainless Steel", commonName: "GPS watch", categoryHint: "electronics", weightMg: 89_000, weightSource: "manufacturer", verified: true });
    const steel = await verify({ brand: "MUNIEQ", name: "Tetra Drip", variant: "Small, stainless steel", gear_type: "Coffee maker", weight_g: 23, weight_source: "measured" });
    expect(steel.refused).toBe(true);
    expect(steel.text).toContain('"Stainless Steel" / "stainless steel"');
    const matched = await verify({ brand: "MUNIEQ", name: "Tetra Drip", variant: "Small, Stainless Steel", gear_type: "Coffee maker", weight_g: 23, weight_source: "measured" });
    expect(matched.refused, matched.text).toBe(false);
    await seedCatalogRow(db, { brand: "Anessa", name: "Sun Milk", commonName: "Sunscreen", categoryHint: "consumable", weightMg: 60_000, weightSource: "manufacturer", verified: true });
    const filed = await verify({ brand: "Bioré", name: "UV Essence", gear_type: "Sunscreen", category: "other", weight_g: 70, weight_source: "measured" });
    expect(filed.refused).toBe(true);
    expect(filed.text).toContain("one gear type, one category");
    // and the way out it names includes the category it was refused for
    expect(filed.text).toContain("To fix it, change the brand, name, variant, gear type, or category");
    // a row already part of a split isn't refused for it: its weight can still be put right,
    // and a write that leaves the split as it was is not the one that made it
    const small = await seedCatalogRow(db, { brand: "Evernew", name: "Ti Mug", variant: "Small, double wall", commonName: "Mug", categoryHint: "cook", weightMg: 90_000 });
    await seedCatalogRow(db, { brand: "Evernew", name: "Ti Mug", variant: "Large, Double Wall", commonName: "Mug", categoryHint: "cook", weightMg: 120_000 });
    const weighed = await verify({ catalog_id: small.id, weight_g: 92, weight_source: "measured" });
    expect(weighed.refused, weighed.text).toBe(false);
    // a third spelling is the write's own, and still refused
    const third = await verify({ catalog_id: small.id, variant: "Small, DOUBLE WALL", weight_g: 92, weight_source: "measured" });
    expect(third.refused).toBe(true);
    // a size letter is put into the catalog's words, not refused
    const sized = await verify({ brand: "Caudata", name: "NewtFlex Pants", variant: "L", gear_type: "Pants", weight_g: 300, weight_source: "measured" });
    expect(sized.refused, sized.text).toBe(false);
    expect(sized.data.row.variant).toBe("Large");
  });

  it("doesn't refuse a new row for another row's misfiling, whose count the new row moves", async () => {
    // one dry bag already filed apart from the others: the audit names it "2 of 3", and a
    // new dry bag filed where the rest are makes that "3 of 4" without being its fault
    await seedCatalogRow(db, { brand: "Sea to Summit", name: "Big River", commonName: "Dry bag", categoryHint: "other", weightMg: 80_000, weightSource: "manufacturer", verified: true });
    await seedCatalogRow(db, { brand: "Hyperlite", name: "Roll-Top Stuff Sack", commonName: "Dry bag", categoryHint: "other", weightMg: 40_000, weightSource: "manufacturer", verified: true });
    await seedCatalogRow(db, { brand: "Granite Gear", name: "eVent Sil Drysack", commonName: "Dry bag", categoryHint: "sleep", weightMg: 30_000, weightSource: "manufacturer", verified: true });
    const added = await verify({ brand: "Osprey", name: "Ultralight Drysack", variant: "20L", gear_type: "Dry bag", category: "other", weight_g: 50, weight_source: "measured" });
    expect(added.refused, added.text).toBe(false);
    // a new row that is itself the misfiling is still refused
    const misfiled = await verify({ brand: "Osprey", name: "Ultralight Roll Top", variant: "12L", gear_type: "Dry bag", category: "sleep", weight_g: 40, weight_source: "measured" });
    expect(misfiled.text).toContain("one gear type, one category");
  });

  it("files a new row's gear type where the verified catalog files it, and reads one it lacks by its words", async () => {
    // the hand table reads "Sunglasses" as clothing; the catalog files them under other
    await seedCatalogRow(db, { brand: "Goodr", name: "OG", commonName: "Sunglasses", categoryHint: "other", weightMg: 23_000, weightSource: "manufacturer", verified: true });
    const shades = await verify({ brand: "Sunski", name: "Treeline", gear_type: "Sunglasses", weight_g: 28, weight_source: "measured" });
    expect(shades.refused, shades.text).toBe(false);
    expect(shades.data.row).toMatchObject({ gear_type: "Sunglasses", category: "other" });
    // a gear type no verified row has: its last word picks the band, and 1.7 kg is a pack's
    const frame = await verify({ brand: "Kifaru", name: "Highcamp 44", gear_type: "Frame pack", weight_g: 1700, weight_source: "measured" });
    expect(frame.refused, frame.text).toBe(false);
    expect(frame.data.row).toMatchObject({ gear_type: "Frame pack", category: "pack" });
  });

  it("closes the suggestions waiting on a row when a verification writes it, and leaves other rows' alone", async () => {
    const row = await seedCatalogRow(db, { brand: "Big Agnes", name: "Rapide SL", variant: "Regular", commonName: "Sleeping pad", categoryHint: "sleep", weightMg: 440_000, weightSource: "manufacturer", verified: true, verifiedBy: admin });
    const other = await seedCatalogRow(db, { brand: "Big Agnes", name: "Zoom UL", variant: "Regular", commonName: "Sleeping pad", categoryHint: "sleep", weightMg: 400_000, weightSource: "manufacturer", verified: true, verifiedBy: admin });
    expect((await proposeCorrection(db, { catalogItemId: row.id, newWeightMg: 470_000 })).status).toBe("proposed");
    expect((await proposeCorrection(db, { catalogItemId: other.id, newWeightMg: 410_000 })).status).toBe("proposed");
    const done = await verify({ catalog_id: row.id, weight_g: 460, weight_source: "measured" });
    expect(done.refused, done.text).toBe(false);
    const statuses = async (id: number) => (await adminCall("get_catalog_edits", { catalog_id: id })).data.edits.map((e: Record<string, unknown>) => [e.kind, e.status]);
    expect(await statuses(row.id)).toEqual([["verification", "applied"], ["correction", "superseded"]]);
    expect(await statuses(other.id)).toEqual([["correction", "proposed"]]);
    // undoing the verification doesn't reopen what it closed
    expect((await adminCall("revert_catalog_edit", { edit_id: done.data.edit_id })).refused).toBe(false);
    expect(await statuses(row.id)).toEqual([["verification", "reverted"], ["correction", "superseded"]]);
  });

  it("puts a community row's name right as it verifies it, and the undo puts the old name back", async () => {
    const row = await seedCatalogRow(db, { brand: "Arc'teryx", name: "Arc'teryx Cormac Hoody", commonName: "Sun hoodie", categoryHint: "clothing", weightMg: 160_000 });
    const asTyped = await verify({ catalog_id: row.id, weight_g: 158, weight_source: "measured" });
    expect(asTyped.text).toContain("name starts with the brand");
    expect(asTyped.text).toContain("beside the catalog_id");
    const renamed = await verify({ catalog_id: row.id, name: "Cormac Hoody", variant: "Men's Large", weight_g: 158, weight_source: "measured" });
    expect(renamed.refused, renamed.text).toBe(false);
    // the apostrophe straight, as the seed spells it, so the research naming it finds this row
    expect(await catalogRow(db, row.id)).toMatchObject({ name: "Cormac Hoody", variant: "Men's Large", verifiedBy: admin });
    expect((await adminCall("revert_catalog_edit", { edit_id: renamed.data.edit_id })).refused).toBe(false);
    expect(await catalogRow(db, row.id)).toMatchObject({ name: "Arc'teryx Cormac Hoody", variant: null, verified: false });
  });

  it("won't undo a rename once another row has the old name, and leaves the edit and both rows as they are", async () => {
    const typed = { brand: "Arc'teryx", name: "Arc'teryx Cormac Crew", commonName: "Sun hoodie", categoryHint: "clothing" };
    const row = await seedCatalogRow(db, { ...typed, weightMg: 160_000 });
    const renamed = await verify({ catalog_id: row.id, name: "Cormac Crew", variant: "Men's Large", weight_g: 158, weight_source: "measured" });
    expect(renamed.refused, renamed.text).toBe(false);
    // another row takes the name the verification replaced
    const taker = await seedCatalogRow(db, { ...typed, weightMg: 161_000 });
    const undo = await adminCall("revert_catalog_edit", { edit_id: renamed.data.edit_id });
    expect(undo.refused).toBe(true);
    expect(undo.text).toBe(`Edit ${renamed.data.edit_id} renamed its row, and another row now has the old name, so it can't be put back. Rename one of them first.`);
    // nothing moved: the edit still stands, and each row keeps what it held
    const [edit] = await db.select().from(schema.catalogEdits).where(eq(schema.catalogEdits.id, renamed.data.edit_id));
    expect(edit!.status).toBe("applied");
    expect(await catalogRow(db, row.id)).toMatchObject({ name: "Cormac Crew", variant: "Men's Large", weightMg: 158_000, verifiedBy: admin });
    expect(await catalogRow(db, taker.id)).toMatchObject({ name: "Arc'teryx Cormac Crew", variant: null, weightMg: 161_000, verified: false });
  });

  it("writes a scale weight over a maker's weight, warns that it replaced it, and the warning's undo puts it back", async () => {
    const row = await seedCatalogRow(db, { brand: "REI Co-op", name: "Packmod Bungees", variant: "2-pack", commonName: "Bungee cord", categoryHint: "other", weightMg: 85_050, weightSource: "manufacturer", sourceUrl: "https://www.rei.com/product/201969", sourceQuote: "Weight: 3 ounces", verified: true, verifiedBy: admin });
    const done = await verify({ catalog_id: row.id, weight_g: 60, weight_source: "measured" });
    expect(done.refused, done.text).toBe(false);
    expect(done.data.warnings).toHaveLength(1);
    expect(done.data.warnings![0]).toContain("maker's published weight (85.05 g, from rei.com)");
    expect(done.data.warnings![0]).toContain("revert_catalog_edit");
    // the maker's quote goes (the undo keeps it); the product page stays as the row's link
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 60_000, weightSource: "measured", sourceQuote: "Weighed on an admin's scale: 60 g", sourceUrl: "https://www.rei.com/product/201969" });
    expect((await adminCall("revert_catalog_edit", { edit_id: done.data.edit_id })).refused).toBe(false);
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 85_050, weightSource: "manufacturer", sourceQuote: "Weight: 3 ounces" });
    // scale weights again: over the first, the second has nothing to warn of
    expect((await verify({ catalog_id: row.id, weight_g: 60, weight_source: "measured" })).refused).toBe(false);
    const again = await verify({ catalog_id: row.id, weight_g: 61, weight_source: "measured" });
    expect(again.refused, again.text).toBe(false);
    expect(again.data.warnings).toBeUndefined();
  });

  it("warns that a scale weight of gear sold by size names no size, and writes it", async () => {
    const base = { brand: "Caudata", name: "Salamander Shell", gear_type: "Rain jacket", weight_g: 210, weight_source: "measured" };
    const unsized = await verify(base);
    expect(unsized.refused, unsized.text).toBe(false);
    expect(unsized.data.warnings).toHaveLength(1);
    expect(unsized.data.warnings![0]).toContain("sold by size");
    const id = (unsized.data.row as { id: number }).id;
    // a retry writes nothing, and still says so
    expect((await verify({ ...base, catalog_id: id })).data).toMatchObject({ unchanged: true, warnings: [expect.stringContaining("sold by size")] });
    // the warning's way out: the same row, the size named
    const sized = await verify({ ...base, catalog_id: id, variant: "Men's Medium" });
    expect(sized.refused, sized.text).toBe(false);
    expect(sized.data.warnings).toBeUndefined();
    // a maker's weight that names no size covers every size, as before
    const maker = await verify({ ...base, name: "Newt Shell", weight_source: "manufacturer", source_url: "https://caudata.example/newt", quote: "Weight: 210 g" });
    expect(maker.data.warnings).toBeUndefined();
    // gear not sold by size needs none
    const pouch = await verify({ brand: "Caudata", name: "Tadpole Pouch", gear_type: "Pouch", weight_g: 30, weight_source: "measured" });
    expect(pouch.refused, pouch.text).toBe(false);
    expect(pouch.data.warnings).toBeUndefined();
  });

  it("lets a near match past only by its own id, once the person says it is another product", async () => {
    const gore = await seedCatalogRow(db, { brand: "Goldwin", name: "GORE-TEX 3L Jacket", commonName: "Rain jacket", categoryHint: "clothing", weightMg: 420_000, verified: true, weightSource: "manufacturer" });
    const args = { brand: "Goldwin", name: "3L Jacket", gear_type: "Rain jacket", weight_g: 400, source_url: "https://goldwin.example/3l", quote: "Weight: 400 g" };
    const near = await verify(args);
    expect(near.refused).toBe(true);
    expect(near.text).toContain(`distinct_from: [${gore.id}]`);
    expect(near.text).toContain("don't rename it");
    // another row's id says nothing about this one
    expect((await verify({ ...args, distinct_from: [duplex] })).text).toContain(`Catalog row ${gore.id}`);
    expect((await verify({ ...args, distinct_from: gore.id })).text).toContain("distinct_from lists");
    const added = await verify({ ...args, distinct_from: [gore.id] });
    expect(added.refused, added.text).toBe(false);
    expect(added.data.created).toBe(true);
    // the exact product is still the row it is, distinct_from or not
    expect((await verify({ ...args, distinct_from: [gore.id] })).text).not.toContain("distinct_from:");
  });

  it("takes mittens for another product than the maker's shirt of the same line and size", async () => {
    await seedCatalogRow(db, { brand: "Yamatomichi", name: "UL Shirt", variant: "Medium", commonName: "Shirt", categoryHint: "clothing", weightMg: 90_000, verified: true, weightSource: "manufacturer", sourceUrl: "https://www.yamatomichi.com/products/ul-shirt" });
    const done = await verify({ brand: "Yamatomichi", name: "UL Mittens", variant: "Medium", gear_type: "Mittens", weight_g: 23, source_url: "https://www.yamatomichi.com/products/ul-mittens", quote: "Weight 19g (Size S) 23g (Size M)" });
    expect(done.refused, done.text).toBe(false);
    expect(done.data).toMatchObject({ created: true, row: { brand: "Yamatomichi", name: "UL Mittens", variant: "Medium", weight_g: 23 } });
  });

  it("holds only the weight for the person, and names the rest in the answer's warnings", async () => {
    const row = await seedCatalogRow(db, { brand: "Acme", name: "Gale Shell", commonName: "Rain jacket", categoryHint: "clothing", weightMg: 100_000, weightSource: "manufacturer", sourceUrl: "https://acme.example/gale", sourceQuote: "Weight: 100 g", verified: true, verifiedBy: admin });
    const held = await verify({ catalog_id: row.id, weight_g: 50, weight_source: "measured" });
    expect(held.refused).toBe(true);
    expect(held.text).toContain("more than 30%");
    expect(held.text).not.toMatch(/maker's published weight|sold by size/);
    expect(await catalogRow(db, row.id)).toMatchObject({ weightMg: 100_000 });
    const done = await verify({ catalog_id: row.id, weight_g: 50, weight_source: "measured", weight_confirmed: true });
    expect(done.refused, done.text).toBe(false);
    expect(done.data.warnings).toEqual([expect.stringContaining("maker's published weight"), expect.stringContaining("sold by size")]);
  });

  it("warns of a scale weight over a maker's on a row it brings back, too", async () => {
    const row = await seedCatalogRow(db, { brand: "Acme", name: "Revived Stake", commonName: "Tent stakes", categoryHint: "shelter", weightMg: 90_000, weightSource: "manufacturer", sourceUrl: "https://acme.example/stake", sourceQuote: "Weight: 90 g", status: "removed" });
    // 80 g is under the range for shelter, which still waits for the person; the maker's weight doesn't
    const done = await verify({ catalog_id: row.id, weight_g: 80, weight_source: "measured", weight_confirmed: true });
    expect(done.refused, done.text).toBe(false);
    expect(done.data).toMatchObject({ revived: true, warnings: [expect.stringContaining("maker's published weight")] });
  });

  it("takes any size a person names in a scale weight's variant, and warns only when there is none", async () => {
    const base = { brand: "Caudata", gear_type: "Rain jacket", weight_g: 210, weight_source: "measured" };
    for (const [name, variant] of [["Axolotl Shell", "Men's Medium Tall"], ["Eft Shell", "Kids Medium"], ["Siren Shell", "Small/Medium"], ["Hellbender Shell", "Men's XXX-Large"]]) {
      const done = await verify({ ...base, name, variant });
      expect(done.refused, `${variant}: ${done.text}`).toBe(false);
      expect(done.data.warnings, variant).toBeUndefined();
    }
    const cut = await verify({ ...base, name: "Olm Shell", variant: "Men's" });
    expect(cut.refused, cut.text).toBe(false);
    expect(cut.data.warnings).toEqual([expect.stringContaining("sold by size")]);
  });

  it("names every near match at once, and lets past only the ones the person checked", async () => {
    const shield = await seedCatalogRow(db, { brand: "Montane", name: "Pertex Shield 3L Jacket", commonName: "Rain jacket", categoryHint: "clothing", weightMg: 420_000, verified: true, weightSource: "manufacturer" });
    const pertex = await seedCatalogRow(db, { brand: "Montane", name: "Pertex 3L Jacket", commonName: "Rain jacket", categoryHint: "clothing", weightMg: 400_000, verified: true, weightSource: "manufacturer" });
    const args = { brand: "Montane", name: "3L Jacket", gear_type: "Rain jacket", weight_g: 410, source_url: "https://montane.example/3l", quote: "Weight: 410 g" };
    const near = await verify(args);
    expect(near.refused).toBe(true);
    expect(near.text).toContain(`${shield.id}, Montane Pertex Shield 3L Jacket`);
    expect(near.text).toContain(`${pertex.id}, Montane Pertex 3L Jacket`);
    // one checked row says nothing about the other
    const one = await verify({ ...args, distinct_from: [shield.id] });
    expect(one.refused).toBe(true);
    expect(one.text).toContain(`Catalog row ${pertex.id}`);
    expect(one.text).toContain(`distinct_from: [${shield.id}, ${pertex.id}]`);
    // at the very weight of a row whose name holds its own, the build's duplicate-name
    // refuses it whatever the person checked, so the tool does too
    const twin = await verify({ ...args, weight_g: 400, quote: "Weight: 400 g", distinct_from: [shield.id, pertex.id] });
    expect(twin.refused).toBe(true);
    expect(twin.text).toContain("one name contains the other");
    const added = await verify({ ...args, distinct_from: [shield.id, pertex.id] });
    expect(added.refused, added.text).toBe(false);
    expect(added.data.created).toBe(true);
  });

  it("reads the kind of gear and the sizes by the gear type as the catalog spells it", async () => {
    await seedCatalogRow(db, { brand: "Prana", name: "Stretch Zion", variant: "Men's Medium, Regular", commonName: "Hiking pants", categoryHint: "clothing", weightMg: 400_000, verified: true, weightSource: "manufacturer" });
    const done = await verify({ brand: "Kuhl", name: "Silencr Pant", variant: "Men's Medium, Regular", gear_type: "Hiking pant", weight_g: 410, weight_source: "measured" });
    expect(done.refused, done.text).toBe(false);
    expect(done.data.row).toMatchObject({ gear_type: "Hiking pants", category: "clothing" });
  });

  it("spells a plural gear type as the vocabulary already has it", async () => {
    await seedCatalogRow(db, { brand: "Sea to Summit", name: "Accessory Bungee", commonName: "Bungee cord", categoryHint: "other", weightMg: 20_000, verified: true, weightSource: "manufacturer" });
    const done = await verify({ brand: "Nite Ize", name: "Gear Tie Bungee", gear_type: "Bungee cords", weight_g: 22, weight_source: "measured" });
    expect(done.refused, done.text).toBe(false);
    expect(done.data.row).toMatchObject({ gear_type: "Bungee cord" });
  });

  it("won't take a fabric's weight per area as what the thing weighs", async () => {
    // 1.0 oz is 28 g, within 8 g of 34: read as a weight, the quote would have backed it
    const done = await verify({ brand: "STAN", name: "DCF Square Purse", variant: "Medium", gear_type: "Wallet", weight_g: 34, source_url: "https://stanstore.official.ec/items/69875220", quote: "Fabric: DCF 1.0 oz/yd²" });
    expect(done.refused).toBe(true);
    expect(done.text).toContain("doesn't state 34 g");
  });

  it("refuses a maker's weight cited to a review site, and a tent stored at its trail weight", async () => {
    const review = await verify({ brand: "Petzl", name: "Actik Core", gear_type: "Headlamp", weight_g: 75, source_url: "https://www.outdoorgearlab.com/reviews/headlamp/petzl-actik-core", quote: "We measured 75 g" });
    expect(review.text).toContain("review site");
    const trail = await verify({ brand: "Nemo", name: "Dagger OSMO 2P", gear_type: "Tent", weight_g: 1450, source_url: "https://www.nemoequipment.com/dagger-osmo", quote: "Minimum trail weight: 1450 g. Packed weight: 1640 g" });
    expect(trail.refused).toBe(true);
    expect(trail.text).toContain("1640");
  });

  it("writes nothing the second time the same call comes", async () => {
    const row = await seedCatalogRow(db, { brand: "Black Diamond", name: "Distance Flask", variant: "500ml", commonName: "Soft flask", categoryHint: "water", weightMg: 40_000 });
    const first = await verify({ catalog_id: row.id, weight_g: 42, weight_source: "measured" });
    const again = await verify({ catalog_id: row.id, weight_g: 42, weight_source: "measured" });
    expect(again.refused, again.text).toBe(false);
    expect(again.data).toMatchObject({ unchanged: true, edit_id: first.data.edit_id });
    expect(await db.select().from(schema.catalogEdits).where(eq(schema.catalogEdits.catalogItemId, row.id))).toHaveLength(1);
  });

  it("stops a loop that went wrong at the hourly ceiling", async () => {
    const row = await seedCatalogRow(db, { brand: "Smartwool", name: "Hike Light Crew", variant: "Men's Large", commonName: "Socks", categoryHint: "clothing", weightMg: 50_000 });
    // the hour's verifications so far, topped up to the ceiling with edits that changed nothing
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.catalogEdits).where(sql`${schema.catalogEdits.undo} is not null`);
    const filler = Array.from({ length: Math.max(0, 60 - Number(n)) }, () => ({ catalogItemId: row.id, oldWeightMg: 50_000, newWeightMg: 50_000, status: "reverted", undo: { status: "active" } }));
    await db.insert(schema.catalogEdits).values(filler);
    try {
      expect((await verify({ catalog_id: row.id, weight_g: 52, weight_source: "measured" })).text).toContain("in the last hour");
    } finally {
      await db.delete(schema.catalogEdits).where(and(eq(schema.catalogEdits.catalogItemId, row.id), eq(schema.catalogEdits.status, "reverted")));
    }
    expect((await verify({ catalog_id: row.id, weight_g: 52, weight_source: "measured" })).refused).toBe(false);
  });
});

describe("linking the person's own piece in the same call", () => {
  const addPiece = async (piece: Record<string, unknown>) => {
    const added = await adminCall("edit_my_gear", { add: [piece] });
    return added.data.results[0].item.id as number;
  };

  it("links the piece, keeping its own name and variant and taking the row's weight", async () => {
    const id = await addPiece({ brand: "Norda", name: "Luster Cap", variant: "Trail Team Edition, L/XL", gear_type: "Hat" });
    const done = await adminCall(TOOL, { brand: "Norda", name: "Luster Cap", gear_type: "Hat", weight_g: 36, source_url: "https://nordarun.com/products/luster-cap-u-rose", quote: "Weight – 36g", gear_id: id });
    expect(done.refused, done.text).toBe(false);
    expect(done.data.gear).toMatchObject({ id, catalog_id: done.data.row.id, weight_g: 36, name: "Luster Cap", variant: "Trail Team Edition, L/XL" });
    // a piece typed without its cut still matches the row's size
    const socks = await addPiece({ brand: "Darn Tough", name: "Light Hiker Micro Crew", variant: "Large", gear_type: "Socks" });
    const pair = await adminCall(TOOL, { brand: "Darn Tough", name: "Light Hiker Micro Crew", variant: "Men's Large", gear_type: "Socks", weight_g: 61, weight_source: "measured", gear_id: socks });
    expect(pair.refused, pair.text).toBe(false);
    expect(pair.data.gear).toMatchObject({ id: socks, weight_g: 61, variant: "Large" });
  });

  it("refuses a piece that isn't the product, or isn't its size, before writing anything", async () => {
    const shoe = await addPiece({ brand: "Houdini", name: "Silvestre Approach Shoe", variant: "EU 44", gear_type: "Approach shoes" });
    const wrong = await adminCall(TOOL, { brand: "Big Agnes", name: "Fly Creek HV UL2", gear_type: "Tent", weight_g: 1100, weight_source: "measured", gear_id: shoe });
    expect(wrong.text).toContain("by Houdini");
    expect(wrong.text).toContain("Nothing was written");
    expect(await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.name, "Fly Creek HV UL2"))).toEqual([]);
    // the same maker, but names that share no word, is another product too
    const unrelated = await adminCall(TOOL, { brand: "Houdini", name: "Pace Pants", gear_type: "Hiking pants", weight_g: 250, weight_source: "measured", variant: "Men's Medium", gear_id: shoe });
    expect(unrelated.text).toContain("doesn't look like");

    const large = await seedCatalogRow(db, { brand: "Patagonia", name: "Quandary Pants", variant: "Large", commonName: "Hiking pants", categoryHint: "clothing", weightMg: 300_000 });
    const medium = await addPiece({ brand: "Patagonia", name: "Quandary Pants", variant: "Medium", gear_type: "Hiking pants" });
    const sized = await adminCall(TOOL, { catalog_id: large.id, weight_g: 305, weight_source: "measured", gear_id: medium });
    expect(sized.text).toContain("is Medium");
    expect((await catalogRow(db, large.id)).verified).toBe(false);

    expect((await adminCall(TOOL, { catalog_id: large.id, weight_g: 305, weight_source: "measured", gear_id: 999_999 })).text).toContain("No piece of your My Gear has id 999999");    // the inseam is read by the gear type as the catalog spells it, a singular included
    await seedCatalogRow(db, { brand: "Prana", name: "Zion Pant", variant: "Men's Medium, Long", commonName: "Hiking pants", categoryHint: "clothing", weightMg: 410_000, verified: true, weightSource: "manufacturer" });
    const short = await addPiece({ brand: "Kuhl", name: "Renegade Pant", variant: "Men's Medium, Short", gear_type: "Hiking pants" });
    const singular = await adminCall(TOOL, { brand: "Kuhl", name: "Renegade Pant", variant: "Men's Medium, Regular", gear_type: "Hiking pant", weight_g: 410, weight_source: "measured", gear_id: short });
    expect(singular.refused).toBe(true);
    expect(singular.text).toContain("is Men’s Medium, Short");
    // a bare shoe number is read as one only by the gear type the catalog spells ("Trail runners")
    await seedCatalogRow(db, { brand: "Altra", name: "Lone Peak 9", variant: "Men's US 9", commonName: "Trail runners", categoryHint: "clothing", weightMg: 300_000, verified: true, weightSource: "manufacturer" });
    const ten = await addPiece({ brand: "Topo", name: "Ultraventure 4", variant: "10" });
    const shoe10 = await adminCall(TOOL, { brand: "Topo", name: "Ultraventure 4", variant: "Men's US 9", gear_type: "Trail runner", weight_g: 280, weight_source: "measured", gear_id: ten });
    expect(shoe10.refused).toBe(true);
    expect(shoe10.text).toContain("is 10, and the row is Men's US 9");
    // a piece typed with only its cut matches a row that names only its cut
    const hoody = await addPiece({ brand: "Arc'teryx", name: "Atom Hoody", variant: "Women's Large", gear_type: "Insulated jacket" });
    const cut = await adminCall(TOOL, { brand: "Arc'teryx", name: "Atom Hoody", variant: "Women's", gear_type: "Insulated jacket", weight_g: 320, source_url: "https://arcteryx.example/atom", quote: "Weight: 320 g", gear_id: hoody });
    expect(cut.refused, cut.text).toBe(false);
    expect(cut.data.gear).toMatchObject({ id: hoody, variant: "Women’s Large", weight_g: 320 });

  });
});

// The field set of each admin tool's answer, held exactly, as mcp.test.ts holds the
// list tools': a producer that grows or loses a field fails here.
describe("the fields each admin tool answers with", () => {
  const keys = (value: unknown) => Object.keys(value as object).sort();
  const ROW = ["brand", "category", "display_name", "gear_type", "id", "name", "source_url", "variant", "verified", "weight_g", "weight_source"];
  let rowId = 0;
  let done: Awaited<ReturnType<typeof adminCall>>;
  // a scale weight over the maker's, with the person's piece linked: every field at once
  beforeAll(async () => {
    const row = await seedCatalogRow(db, { brand: "Nite Ize", name: "Gear Tie", variant: "2-pack", commonName: "Gear tie", categoryHint: "other", weightMg: 85_050, weightSource: "manufacturer", sourceUrl: "https://niteize.example/gear-tie", sourceQuote: "Weight: 3 ounces", verified: true, verifiedBy: admin });
    rowId = row.id;
    const piece = (await adminCall("edit_my_gear", { add: [{ brand: "Nite Ize", name: "Gear Tie", variant: "2-pack" }] })).data.results[0].item.id as number;
    done = await adminCall(TOOL, { catalog_id: rowId, weight_g: 60, weight_source: "measured", gear_id: piece });
  });

  it("verify_catalog_item: the answer, with a warning and a linked piece, and its row", () => {
    expect(done.refused, done.text).toBe(false);
    expect(keys(done.data)).toEqual(["created", "edit_id", "gear", "revived", "row", "unchanged", "warnings"]);
    expect(keys(done.data.row)).toEqual(ROW);
  });

  it("get_catalog_edits: the answer and an edit", async () => {
    const history = await adminCall("get_catalog_edits", { catalog_id: rowId });
    expect(keys(history.data)).toEqual(["edits"]);
    expect(keys(history.data.edits[0])).toEqual(["at", "catalog_id", "id", "item", "kind", "new_weight_g", "old_weight_g", "reason", "source_url", "status"]);
  });

  it("revert_catalog_edit: the answer and its row", async () => {
    const undone = await adminCall("revert_catalog_edit", { edit_id: done.data.edit_id });
    expect(undone.refused, undone.text).toBe(false);
    expect(keys(undone.data)).toEqual(["edit_id", "rejected", "retired", "row"]);
    expect(keys(undone.data.row)).toEqual(ROW);
  });
});
