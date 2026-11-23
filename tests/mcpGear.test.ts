import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import {
  ACCESS_TOKENS_MAX,
  ACCESS_TOKEN_PREFIX,
  issueAppTokens,
  listAccessTokens,
  mintAccessToken,
  resolveBearer,
  revokeAccessToken,
  revokeAllAccessTokens,
} from "../server/utils/accessTokens";
import { deleteAccount } from "../server/utils/accountRepo";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { listClaimedLists } from "../server/utils/claimRepo";
import { REPLAY_WAIT } from "../server/utils/mcp";
import { sizeConflict } from "../server/utils/catalogSizes";
import { LISTS_DDL } from "../server/utils/db";
import { rateLimitSubject } from "../server/utils/rateLimit";
import { sha256Hex } from "../server/utils/tokens";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { applyVaultItemOp } from "../server/utils/vaultRepo";
import { createTestDb, type TestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";
import { makeEvent } from "./helpers/http";
import { expectResultConforms } from "./helpers/mcpSchema";

// The account side of the connector, driven through the real endpoint against a real
// (in-memory) database: tokens are minted for two accounts, and requests carrying one
// read, add to, change, link to the catalog and put away gear and name the account's
// lists, while requests carrying none, or a dead one, are refused at the door with the
// 401 that starts a sign-in. Three things are held here above all — a token reaches its
// own account's gear and lists and no other's, a read-only token writes nothing, and a
// revoked token is dead on the next call. The sign-in itself is tests/oauth.test.ts.

vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));
// the shared KV the replay windows live in, as a Map, emptied after every test so a
// call in one can't be taken for a retry of another's
const kv = vi.hoisted(() => new Map<string, unknown>());
const ttls = vi.hoisted(() => new Map<string, number | undefined>());
vi.mock("../server/utils/rateLimit", () => ({
  rateLimit: async () => {},
  rateLimitSubject: vi.fn(async () => {}),
  useKv: () => ({
    getItem: async <T,>(key: string) => (kv.get(key) as T | undefined) ?? null,
    setItem: async <T,>(key: string, value: T, opts?: { ttl?: number }) => {
      kv.set(key, value);
      ttls.set(key, opts?.ttl);
    },
  }),
}));
afterEach(() => {
  kv.clear();
  ttls.clear();
});
// the catalog reads pick their SQL by DATABASE_URL at call time; a shell with it
// exported must not turn this suite red for a reason that has nothing to do with the code
vi.stubEnv("DATABASE_URL", "");

type ToolAnswer = { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean };

/** one JSON-RPC POST, with the bearer header when a token is given */
async function post(body: unknown, token?: string) {
  const event = makeEvent("/mcp", { method: "POST", body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const reply = (await mcp(event)) as { result?: ToolAnswer; error?: string; error_description?: string };
  return { status: event.node.res.statusCode, challenge: String(event.node.res.getHeader("www-authenticate") ?? ""), reply };
}
async function tool(name: string, args: unknown, token?: string) {
  const { status, reply } = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, token);
  const result = reply.result;
  if (!result) throw new Error(`${name} was refused at the door (${status}: ${reply.error_description ?? reply.error})`);
  // every structured answer is checked against the tool's declared shape, as a
  // validating client would check it
  expectResultConforms(name, result);
  return {
    status,
    data: result.structuredContent as Record<string, unknown>,
    text: result.content[0]!.text,
    refused: result.isError ?? false,
  };
}
/** the door's answer to a gear call: the status, the WWW-Authenticate challenge and the body */
async function door(name: string, args: unknown, token?: string) {
  const { status, challenge, reply } = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, token);
  return { status, challenge, error: reply.error, description: reply.error_description, result: reply.result };
}
const names = (r: { data: Record<string, unknown> }) => (r.data.gear as { name: string }[]).map((g) => g.name);

let db: TestDb;
let alice = 0;
let bob = 0;
let aliceRead = "";
let aliceWrite = "";
let bobWrite = "";
const NEVER_MINTED = `${ACCESS_TOKEN_PREFIX}this-was-never-minted`;

beforeAll(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL, CATALOG_DDL);
  dbState.db = db;
  // one catalog row, for the pieces that name a catalog_id
  await db.insert(schema.catalogItems).values([
    { brand: "Zpacks", name: "Duplex", variant: null, weightMg: 538_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/duplex", verified: true, commonName: "Tent", categoryHint: "shelter", searchTerms: "tent shelter" },
    { brand: "Clif", name: "Builders Bar", variant: null, weightMg: 68_000, weightSource: "manufacturer", sourceUrl: "https://clifbar.com/builders", verified: true, commonName: "Energy bar", categoryHint: "consumable", kcal: 290, searchTerms: "snack food" },
  ]);
  [alice, bob] = (await db.insert(schema.users).values([{ email: "alice@example.com" }, { email: "bob@example.com" }]).returning()).map((u) => u.id);
  aliceRead = (await mintAccessToken(db, alice, { label: "Reader", scope: "read", unproven: false }))!.token;
  aliceWrite = (await mintAccessToken(db, alice, { label: "Claude Code", scope: "write", unproven: false }))!.token;
  bobWrite = (await mintAccessToken(db, bob, { scope: "write", unproven: false }))!.token;
});

describe("minting and revoking", () => {
  it("keeps the hash, not the value, and resolves a value to its account and scope", async () => {
    expect(aliceWrite.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(aliceWrite.length).toBeGreaterThan(40);
    const stored = await db.select({ hash: schema.accessTokens.tokenHash }).from(schema.accessTokens);
    expect(stored.map((r) => r.hash)).not.toContain(aliceWrite);
    expect(stored.every((r) => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);
    expect(await resolveBearer(db, aliceWrite)).toEqual({ userId: alice, scope: "write" });
    expect(await resolveBearer(db, aliceRead)).toEqual({ userId: alice, scope: "read" });
    expect(await resolveBearer(db, NEVER_MINTED)).toBeNull();
  });

  it("lists an account's tokens as metadata, newest first, with their first use stamped", async () => {
    const listed = await listAccessTokens(db, alice);
    expect(listed.map((t) => [t.kind, t.label, t.scope])).toEqual([["token", "Claude Code", "write"], ["token", "Reader", "read"]]);
    expect(JSON.stringify(listed)).not.toContain(aliceWrite);
    // both were resolved in the case above
    expect(listed.map((t) => typeof t.lastUsedAt)).toEqual(["string", "string"]);
  });

  it("lets an account revoke only its own", async () => {
    const spare = (await mintAccessToken(db, alice, { scope: "read", unproven: false }))!;
    expect(await revokeAccessToken(db, bob, spare.id)).toBe(false);
    expect(await resolveBearer(db, spare.token)).not.toBeNull();
    expect(await revokeAccessToken(db, alice, spare.id)).toBe(true);
    expect(await resolveBearer(db, spare.token)).toBeNull();
  });

  it("refuses the token past the ceiling", async () => {
    // bob holds one already, so the ceiling is reached one mint early
    const minted = [];
    for (let i = 0; i < ACCESS_TOKENS_MAX; i++) minted.push(await mintAccessToken(db, bob, { scope: "read", unproven: false }));
    expect(minted.filter(Boolean)).toHaveLength(ACCESS_TOKENS_MAX - 1);
    expect(minted[ACCESS_TOKENS_MAX - 1]).toBeNull();
    for (const t of await listAccessTokens(db, bob)) if (t.scope === "read") await revokeAccessToken(db, bob, t.id);
    expect(await listAccessTokens(db, bob)).toHaveLength(1);
  });
});

describe("the gear tools", () => {
  it("are refused at the door without a token: the 401 that starts a sign-in, never a tool error", async () => {
    const none = await door("get_my_gear", {});
    expect(none.status).toBe(401);
    expect(none.result).toBeUndefined();
    expect(none.error).toBe("invalid_token");
    expect(none.challenge).toContain('Bearer error="invalid_token"');
    expect(none.challenge).toContain('resource_metadata="http://mahonia.test/.well-known/oauth-protected-resource/mcp"');
    // a read tool asks for read-and-change too: Claude asks for exactly what the 401
    // names and doesn't step up on the 403, so a read sign-in would be stuck at the
    // first change
    expect(none.challenge).toContain('scope="write"');
    expect((await door("edit_my_gear", { add: [{ name: "x" }] })).challenge).toContain('scope="write"');
    const dead = await door("get_my_gear", {}, NEVER_MINTED);
    expect(dead.status).toBe(401);
    expect(dead.description).toContain("again");
    // a bearer that is not one of ours is not looked up: the connector is anonymous
    const foreign = await door("get_my_gear", {}, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ABCDE");
    expect(foreign.status).toBe(401);
    expect(foreign.description).toContain("Sign in");
    // and nothing else at the endpoint asks for a credential
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).status).toBe(200);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(200);
  });

  it("read an account that has no gear yet as empty", async () => {
    const r = await tool("get_my_gear", {}, aliceRead);
    expect(r.refused, r.text).toBe(false);
    expect(r.data).toEqual({ gear: [], total: 0, offset: 0 });
  });

  it("let a read-only token change nothing, not even mint the vault: a 403 that asks for write", async () => {
    const r = await door("edit_my_gear", { add: [{ name: "X-Mid 2" }] }, aliceRead);
    expect(r.status).toBe(403);
    expect(r.error).toBe("insufficient_scope");
    expect(r.challenge).toContain('Bearer error="insufficient_scope"');
    expect(r.challenge).toContain('scope="write"');
    // Claude doesn't step up on it, so the words say what the person can do instead
    expect(r.description).toContain("connect Mahonia again");
    expect(await db.select().from(schema.vaults)).toHaveLength(0);
  });

  let tentId = 0;
  it("add pieces, and report a piece the account already holds", async () => {
    const r = await tool(
      "edit_my_gear",
      {
        add: [
          { name: "X-Mid 2", brand: "Durston", gear_type: "Tent", weight_g: 1000, price: 329, currency: "usd" },
          { name: "Flash 55", brand: "REI", variant: "M", weight_g: 1190, classification: "base" },
          { name: "" },
        ],
      },
      aliceWrite,
    );
    expect(r.refused, r.text).toBe(false);
    expect(r.data.added).toBe(2);
    const results = r.data.results as { index: number; status: string; item?: Record<string, unknown> }[];
    expect(results.map((x) => x.status)).toEqual(["added", "added", "invalid"]);
    // kind is the gear page's section, read from the gear type; a name it can't place is Other
    expect(results[0]!.item).toMatchObject({ display_name: "Durston X-Mid 2", gear_type: "Tent", kind: "Shelter", weight_g: 1000, price: 329, currency: "USD" });
    tentId = results[0]!.item!.id as number;

    // identity is brand + name + variant, case-folded
    const again = await tool("edit_my_gear", { add: [{ name: "x-mid 2", brand: "DURSTON" }] }, aliceWrite);
    expect((again.data.results as { status: string }[]).map((x) => x.status)).toEqual(["already_have"]);
    // and answered with the piece, found by the key the vault derived: the stored name
    // is tidied (a zero-width space deleted), which re-folding the typed one misses
    const hidden = await tool("edit_my_gear", { add: [{ name: "X-Mi​d 2", brand: "Durston" }] }, aliceWrite);
    expect(hidden.data.results).toMatchObject([{ status: "already_have", item: { id: tentId } }]);
  });

  it("pin every field an add gives, so a later list save leaves them alone", async () => {
    const [tent] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, tentId));
    expect(tent).toMatchObject({ namePinned: true, weightPinned: true, commonNamePinned: true, pricePinned: true });
  });

  it("list everything, rank by a query, and page", async () => {
    const all = await tool("get_my_gear", {}, aliceRead);
    expect(all.data.total).toBe(2);
    expect(names(await tool("get_my_gear", { query: "flash" }, aliceRead))).toEqual(["Flash 55"]);
    const page = await tool("get_my_gear", { limit: 1, offset: 1 }, aliceRead);
    expect(page.data).toMatchObject({ total: 2, offset: 1 });
    expect(page.data.gear).toHaveLength(1);
    // the last page says nothing more; an earlier one says where the next begins
    expect(page.data).not.toHaveProperty("next_offset");
    expect((await tool("get_my_gear", { limit: 1 }, aliceRead)).data).toMatchObject({ offset: 0, next_offset: 1 });
    expect((await tool("get_my_gear", { query: "x" }, aliceRead)).refused).toBe(true);
  });

  // how many of a piece the owner has: one piece with owned 3, never three pieces, and
  // read back on every piece so an agent can tell three bottles from one
  it("reads and sets how many of a piece the owner has", async () => {
    const before = (await tool("get_my_gear", {}, aliceRead)).data.gear as Record<string, unknown>[];
    expect(before.every((g) => g.owned === 1)).toBe(true);
    const set = (await tool("edit_my_gear", { update: [{ id: tentId, owned: 3 }] }, aliceWrite)).data.updated as { item: Record<string, unknown> }[];
    expect(set[0]!.item).toMatchObject({ id: tentId, owned: 3 });
    const read = (await tool("get_my_gear", {}, aliceRead)).data.gear as Record<string, unknown>[];
    expect(read.find((g) => g.id === tentId)).toMatchObject({ owned: 3 });
    // none owned isn't a count it can store (no count reads as one): refused, not made 1
    const none = (await tool("edit_my_gear", { update: [{ id: tentId, owned: 0 }] }, aliceWrite)).data.updated as { status: string; reason: string }[];
    expect(none[0]).toMatchObject({ status: "invalid" });
    expect(none[0]!.reason).toContain("1 or more");
    expect((await tool("get_my_gear", {}, aliceRead)).data.gear).toContainEqual(expect.objectContaining({ id: tentId, owned: 3 }));
    const back = (await tool("edit_my_gear", { update: [{ id: tentId, owned: null }] }, aliceWrite)).data.updated as { item: Record<string, unknown> }[];
    expect(back[0]!.item).toMatchObject({ owned: 1 });
  });

  it("change one field, clear another, and mark an empty change invalid", async () => {
    const r = await tool("edit_my_gear", { update: [{ id: tentId, weight_g: 1010, price: null }] }, aliceWrite);
    expect(r.refused, r.text).toBe(false);
    const [done] = r.data.updated as { id: number; status: string; item: Record<string, unknown> }[];
    expect(done).toMatchObject({ id: tentId, status: "updated", item: { id: tentId, weight_g: 1010 } });
    // a cleared field is gone from the echo, as every field with nothing in it is
    expect(done!.item).not.toHaveProperty("price");
    expect(done!.item).not.toHaveProperty("currency");
    expect(done!.item).not.toHaveProperty("times_used");
    // a piece keeps a name, and an entry with nothing to change is said so, piece by piece
    const bad = (await tool("edit_my_gear", { update: [{ id: tentId, name: null }, { id: tentId }] }, aliceWrite)).data.updated as { status: string }[];
    expect(bad.map((u) => u.status)).toEqual(["invalid", "invalid"]);
    // a call with nothing in it, or an entry with no id, is refused whole
    expect((await tool("edit_my_gear", {}, aliceWrite)).refused).toBe(true);
    expect((await tool("edit_my_gear", { update: [{ weight_g: 1 }] }, aliceWrite)).refused).toBe(true);
  });

  it("never reach another account's gear, by id or by listing", async () => {
    const bobs = await tool("edit_my_gear", { add: [{ name: "Windburner" }] }, bobWrite);
    const bobsId = (bobs.data.results as { item: { id: number } }[])[0]!.item.id;
    const touched = await tool("edit_my_gear", { update: [{ id: bobsId, weight_g: 1 }], remove: [bobsId] }, aliceWrite);
    expect((touched.data.updated as { status: string }[])[0]!.status).toBe("not_found");
    expect((touched.data.removed as { status: string }[])[0]!.status).toBe("not_found");
    expect(names(await tool("get_my_gear", {}, aliceWrite))).not.toContain("Windburner");
  });

  it("put a piece away and bring it back", async () => {
    expect((await tool("edit_my_gear", { remove: [tentId] }, aliceWrite)).data.removed).toEqual([{ id: tentId, status: "removed" }]);
    expect((await tool("get_my_gear", {}, aliceRead)).data.total).toBe(1);
    expect((await tool("edit_my_gear", { remove: [tentId] }, aliceWrite)).data.removed).toEqual([{ id: tentId, status: "not_found" }]);
    // an id named twice reads as remove reads it: a miss the second time
    expect((await tool("edit_my_gear", { restore: [tentId, tentId] }, aliceWrite)).data.removed).toEqual([{ id: tentId, status: "restored" }, { id: tentId, status: "not_found" }]);
    expect((await tool("get_my_gear", {}, aliceRead)).data.total).toBe(2);
  });

  it("link a piece to the catalog as it is added, taking the catalog's fields where none were given, or later, keeping its own, and unlink", async () => {
    const r = await tool("edit_my_gear", { add: [{ catalog_id: 1 }, { name: "Spare Duplex", catalog_id: 1, weight_g: 90 }] }, aliceWrite);
    expect(r.refused, r.text).toBe(false);
    const results = r.data.results as { status: string; item?: Record<string, unknown> }[];
    expect(results.map((x) => x.status)).toEqual(["added", "added"]);
    // named by the catalog alone: the catalog's brand, name, gear type and weight
    expect(results[0]!.item).toMatchObject({ display_name: "Zpacks Duplex", gear_type: "Tent", weight_g: 538, catalog_id: 1 });
    // the fields given stand over the catalog's; the link is the same
    expect(results[1]!.item).toMatchObject({ name: "Spare Duplex", brand: "Zpacks", weight_g: 90, catalog_id: 1 });
    const duplexId = results[0]!.item!.id as number;
    expect((await tool("get_my_gear", { query: "duplex" }, aliceRead)).data.gear).toHaveLength(2);
    // linked later to another maker's product: refused, the piece left as it was (it
    // used to be renamed to the row, which at least showed the mistake; now it keeps its
    // own name, so a wrong row is refused instead of taken quietly)
    const wrong = (await tool("edit_my_gear", { update: [{ id: tentId, catalog_id: 1, weight_g: 1200 }] }, aliceWrite)).data.updated as { status: string; reason?: string }[];
    expect(wrong[0]).toMatchObject({ status: "invalid" });
    expect(wrong[0]!.reason).toContain("is by Durston");
    // unlinked: the piece as it reads, with no link
    const unlinked = (await tool("edit_my_gear", { update: [{ id: duplexId, catalog_id: null }] }, aliceWrite)).data.updated as { item: Record<string, unknown> }[];
    expect(unlinked[0]!.item).toMatchObject({ name: "Duplex", weight_g: 538 });
    expect(unlinked[0]!.item).not.toHaveProperty("catalog_id");
    // an id that names no catalog row refuses the call before anything is written
    const before = (await tool("get_my_gear", {}, aliceRead)).data.total;
    const refused = await tool("edit_my_gear", { add: [{ name: "x", catalog_id: 404 }], remove: [duplexId] }, aliceWrite);
    expect(refused.refused).toBe(true);
    expect(refused.text).toContain("isn't in the catalog");
    expect((await tool("edit_my_gear", { update: [{ id: duplexId, catalog_id: 1.5 }] }, aliceWrite)).refused).toBe(true);
    expect((await tool("get_my_gear", {}, aliceRead)).data.total).toBe(before);
  });

  // A connector chat linked a cap typed "L/XL" to a catalog row with no size (one weight
  // for every size), and the link wrote the row's empty variant over the owner's.
  it("links a piece already held without writing over what is its own, and refuses another product or size", async () => {
    const cited = { weightSource: "manufacturer", sourceUrl: "https://maker.example/p", verified: true, categoryHint: "clothing" };
    const [capRow, large, medium] = await db
      .insert(schema.catalogItems)
      .values([
        { ...cited, brand: "Norda", name: "Luster Cap", variant: null, weightMg: 36_000, commonName: "Hat" },
        { ...cited, brand: "Patagonia", name: "Quandary Pants", variant: "Large", weightMg: 300_000, commonName: "Hiking pants" },
        { ...cited, brand: "Patagonia", name: "Quandary Pants", variant: "Medium", weightMg: 290_000, commonName: "Hiking pants" },
      ])
      .returning();
    const add = await tool(
      "edit_my_gear",
      {
        add: [
          { brand: "Norda", name: "Luster Cap", variant: "L/XL" },
          { brand: "Zpacks", name: "My Duplex", gear_type: "Shelter", weight_g: 560 },
          { brand: "Patagonia", name: "Quandary Pants", variant: "Medium", weight_g: 280 },
          { brand: "Patagonia", name: "Quandary Pants", variant: "Men's L" },
          { brand: "Clif", name: "Builders Bar Trail Ration", classification: "worn" },
        ],
      },
      aliceWrite,
    );
    expect(add.refused, add.text).toBe(false);
    const [cap, duplex, mediumPiece, largePiece, bar] = (add.data.results as { item: { id: number } }[]).map((x) => x.item.id);
    type Updated = { status: string; item?: Record<string, unknown>; reason?: string };
    const update = async (...entries: Record<string, unknown>[]) => (await tool("edit_my_gear", { update: entries }, aliceWrite)).data.updated as Updated[];

    const [capped, own, refused, sized, food] = await update(
      { id: cap, catalog_id: capRow!.id },
      { id: duplex, catalog_id: 1 },
      { id: mediumPiece, catalog_id: large!.id },
      { id: largePiece, catalog_id: large!.id },
      { id: bar, catalog_id: 2 },
    );
    // its size and name kept; the weight and gear type it lacked, from the row
    expect(capped).toMatchObject({ status: "updated", item: { name: "Luster Cap", brand: "Norda", variant: "L/XL", weight_g: 36, gear_type: "Hat", catalog_id: capRow!.id } });
    // a weight and gear type of its own stand over the row's
    expect(own).toMatchObject({ status: "updated", item: { name: "My Duplex", weight_g: 560, gear_type: "Shelter", catalog_id: 1 } });
    // a link is to one size: the Medium isn't linked to the Large, and is left as it was
    expect(refused).toMatchObject({ status: "invalid" });
    expect(refused!.reason).toContain("a link is to one size");
    // the same size typed with its cut and a letter is the row's size
    expect(sized).toMatchObject({ status: "updated", item: { variant: "Men’s L", weight_g: 300, gear_type: "Hiking pants", catalog_id: large!.id } });
    // food is consumable, but a piece its owner filed as worn stays worn, as on the site
    expect(food).toMatchObject({ status: "updated", item: { classification: "worn", weight_g: 68, kcal: 290, catalog_id: 2 } });

    // a relink replaces what the earlier link gave (the Large's 300 g), not what is the owner's
    const [moved] = await update({ id: largePiece, variant: "Medium", catalog_id: medium!.id });
    expect(moved).toMatchObject({ status: "updated", item: { variant: "Medium", weight_g: 290, catalog_id: medium!.id } });
    // and the owner's own weight survives a relink to its size
    const [ownSize] = await update({ id: mediumPiece, catalog_id: medium!.id });
    expect(ownSize).toMatchObject({ status: "updated", item: { variant: "Medium", weight_g: 280, catalog_id: medium!.id } });

    // another size typed onto a linked piece unlinks it, as the site does; the weight stays
    const [retyped] = await update({ id: largePiece, variant: "Large" });
    expect(retyped).toMatchObject({ status: "updated", item: { variant: "Large", weight_g: 290 } });
    expect(retyped!.item).not.toHaveProperty("catalog_id");
    expect(retyped!.reason).toContain(`Unlinked from catalog row ${medium!.id}`);
    // a size typed onto a piece linked to a row that names none keeps the link
    const [resized] = await update({ id: cap, variant: "S/M" });
    expect(resized).toMatchObject({ status: "updated", item: { variant: "S/M", catalog_id: capRow!.id } });

    // another product is refused, and the piece is left as it was
    const [wrong] = await update({ id: duplex, catalog_id: capRow!.id });
    expect(wrong).toMatchObject({ status: "invalid" });
    expect(wrong!.reason).toContain("is by Zpacks");
    // a piece spelled wholly by an earlier link is judged as it stands, not as the new row
    // would spell it: a cap relinked to a pair of pants is refused
    const spelled = (await tool("edit_my_gear", { add: [{ catalog_id: capRow!.id }] }, aliceWrite)).data.results as { item: { id: number } }[];
    const [relinked] = await update({ id: spelled[0]!.item.id, catalog_id: large!.id });
    expect(relinked).toMatchObject({ status: "invalid" });
    expect(relinked!.reason).toContain("is by Norda");
  });

  it("relinks without moving a piece's size unasked, and replaces what the old row gave even once it was re-weighed or retired", async () => {
    const cited = { weightSource: "manufacturer", sourceUrl: "https://maker.example/k", verified: true, categoryHint: "clothing", commonName: "Rain pants" };
    const [kLarge, kMedium, kNext, borealis, nutBar, bag] = await db
      .insert(schema.catalogItems)
      .values([
        { ...cited, brand: "Rab", name: "Kinetic Pants", variant: "Large", weightMg: 320_000 },
        { ...cited, brand: "Rab", name: "Kinetic Pants", variant: "Medium", weightMg: 310_000 },
        { ...cited, brand: "Rab", name: "Kinetic 2.0 Pants", variant: "Medium", weightMg: 300_000 },
        { ...cited, brand: "Rab", name: "Borealis Jacket", variant: "Women's", weightMg: 250_000, commonName: "Softshell jacket" },
        { ...cited, brand: "Clif", name: "Nut Butter Bar", variant: null, weightMg: 50_000, commonName: "Energy bar", categoryHint: "consumable", kcal: 230 },
        { ...cited, brand: "Clif", name: "Nut Butter Bar Tote", variant: null, weightMg: 40_000, commonName: null, categoryHint: "other" },
      ])
      .returning();
    type Updated = { status: string; item?: Record<string, unknown>; reason?: string };
    const update = async (...entries: Record<string, unknown>[]) => (await tool("edit_my_gear", { update: entries }, aliceWrite)).data.updated as Updated[];
    const add = async (...pieces: Record<string, unknown>[]) =>
      ((await tool("edit_my_gear", { add: pieces }, aliceWrite)).data.results as Updated[]);

    // a piece added from the catalog, relinked to another size: refused unless the call says the size
    const [fromRow] = await add({ catalog_id: kLarge!.id });
    const pieceId = fromRow!.item!.id as number;
    const [unasked] = await update({ id: pieceId, catalog_id: kMedium!.id });
    expect(unasked).toMatchObject({ status: "invalid" });
    expect(unasked!.reason).toContain("send its variant with the link");
    const [asked] = await update({ id: pieceId, catalog_id: kMedium!.id, variant: "Medium" });
    expect(asked).toMatchObject({ status: "updated", item: { variant: "Medium", weight_g: 310, catalog_id: kMedium!.id } });

    // the Medium re-weighed after the link: its old 310 g is still the link's, so a relink replaces it
    await db.update(schema.catalogItems).set({ weightMg: 315_000 }).where(eq(schema.catalogItems.id, kMedium!.id));
    await db.insert(schema.catalogEdits).values({ catalogItemId: kMedium!.id, oldWeightMg: 310_000, newWeightMg: 315_000, status: "applied", reason: "re-weighed" });
    const [back] = await update({ id: pieceId, catalog_id: kLarge!.id, variant: "Large" });
    expect(back).toMatchObject({ status: "updated", item: { variant: "Large", weight_g: 320, catalog_id: kLarge!.id } });

    // a piece linked to a row since retired still unlinks when another size is typed onto it
    await db.update(schema.catalogItems).set({ status: "removed" }).where(eq(schema.catalogItems.id, kLarge!.id));
    const [retyped] = await update({ id: pieceId, variant: "Medium" });
    expect(retyped).toMatchObject({ status: "updated", item: { variant: "Medium" } });
    expect(retyped!.item).not.toHaveProperty("catalog_id");
    expect(retyped!.reason).toContain(`Unlinked from catalog row ${kLarge!.id}`);
    // and a retired row's weight is still the link's on a relink
    const [second] = await add({ catalog_id: kMedium!.id });
    await db.update(schema.catalogItems).set({ status: "removed" }).where(eq(schema.catalogItems.id, kMedium!.id));
    const [onward] = await update({ id: second!.item!.id, catalog_id: kNext!.id });
    expect(onward).toMatchObject({ status: "updated", item: { name: "Kinetic 2.0 Pants", variant: "Medium", weight_g: 300, catalog_id: kNext!.id } });

    // food the link made consumable, its calories and gear type go with a relink to a row that has none
    const [bar] = await add({ catalog_id: nutBar!.id });
    expect(bar).toMatchObject({ status: "added", item: { classification: "consumable", kcal: 230, gear_type: "Energy bar" } });
    const [tote] = await update({ id: bar!.item!.id, catalog_id: bag!.id });
    expect(tote).toMatchObject({ status: "updated", item: { name: "Nut Butter Bar Tote", weight_g: 40, catalog_id: bag!.id } });
    expect(tote!.item).not.toHaveProperty("kcal");
    expect(tote!.item).not.toHaveProperty("gear_type");
    expect(tote!.item!.classification).not.toBe("consumable");

    // a row that names only its cut takes a piece of that cut in any size, and asks a bare size for its cut
    const [hers, bare] = await add({ brand: "Rab", name: "Borealis Jacket", variant: "Women's Large" }, { brand: "Rab", name: "Borealis Jacket", variant: "Large", owned: 2 });
    const [cutLinked, cutAsked] = await update({ id: hers!.item!.id, catalog_id: borealis!.id }, { id: bare!.item!.id, catalog_id: borealis!.id });
    expect(cutLinked).toMatchObject({ status: "updated", item: { variant: "Women’s Large", weight_g: 250, catalog_id: borealis!.id } });
    expect(cutAsked).toMatchObject({ status: "invalid" });
    expect(cutAsked!.reason).toContain("Women's in any size");

    // a colour run on without a comma is the owner's own word, not another size
    const [coloured] = await add({ brand: "Rab", name: "Kinetic 2.0 Pants", variant: "Medium Black" });
    const [colourLinked] = await update({ id: coloured!.item!.id, catalog_id: kNext!.id });
    expect(colourLinked).toMatchObject({ status: "updated", item: { variant: "Medium Black", catalog_id: kNext!.id } });

    // names that share no word are another product, held or added
    const [bivy] = await add({ brand: "Rab", name: "Alpine Bivi" });
    const [heldOther] = await update({ id: bivy!.item!.id, catalog_id: kNext!.id });
    expect(heldOther).toMatchObject({ status: "invalid" });
    expect(heldOther!.reason).toContain("doesn't look like");
    const [addedOther] = await add({ brand: "Rab", name: "Neutrino Bag", catalog_id: kNext!.id });
    expect(addedOther).toMatchObject({ status: "invalid" });
    expect(addedOther!.reason).toContain("doesn't look like");

    // an update that neither links nor retypes a size reads nothing of the catalog
    const reads = vi.spyOn(db, "select");
    try {
      await update({ id: colourLinked!.item!.id as number, weight_g: 305 });
      const linkedReads = reads.mock.calls.length;
      reads.mockClear();
      await update({ id: bivy!.item!.id as number, weight_g: 900 });
      expect(linkedReads).toBe(reads.mock.calls.length);
    } finally {
      reads.mockRestore();
    }
  });

  it("tells two sizes apart axis by axis, the cut and the owner's own extra words aside", () => {
    const row = (variant: string | null, commonName = "Hiking pants", categoryHint = "clothing") => ({ brand: null, name: "x", variant, commonName, categoryHint });
    const differ: [string, string, string?, string?][] = [
      ["X-Large", "Large"],
      ["Large", "X-Large"],
      ["Medium", "Large"],
      ["Women's US 8", "Men's US 8.5", "Trail runners"],
      ["US 9", "US 9.5", "Trail runners"],
      ["Men's", "Women's", "Trail runners"],
      ["25F, Large", "25F, X-Large", "Quilt", "sleep"],
      ["Regular", "Regular Wide", "Sleeping pad", "sleep"],
      ["Regular Wide", "Regular", "Sleeping pad", "sleep"],
      ["Regular", "20F, Regular", "Quilt", "sleep"],
      ["6ft", "6ft 6in", "Quilt", "sleep"],
      ["2-pack", "3-pack", "Bungee cord", "other"],
      ["47mm", "47mm, Solar", "Watch", "electronics"],
      // a lower-case letter is the size it names
      ["m", "Large"],
      // a row that names only its cut is that cut, in any size
      ["Large", "Women's", "Fleece"],
      ["Men's Large", "Women's", "Fleece"],
      // typed loosely, a size is still read, and still another size
      ["Mens Medium", "Men's Small", "Rain jacket"],
      ["men's large", "Men's Small", "Rain jacket"],
      ["Medium Black", "Large", "Rain jacket"],
      ["Wide Regular", "Long", "Sleeping pad", "sleep"],
      ["6ft 6in Black", "6ft", "Bivy", "shelter"],
      ["2 m", "1m", "Charging cable", "electronics"],
      // a word the reader can't place still tells two rows apart
      ["Men's Medium, Short", "Men's Medium, Regular", "Rain jacket"],
      ["Regular", "Regular Mummy", "Sleeping pad", "sleep"],
      ["Double Wide", "Long", "Sleeping pad", "sleep"],
      ["Standard", "X-Large", "Food bag", "other"],
    ];
    for (const [piece, catalog, type, kind] of differ) expect(sizeConflict(piece, row(catalog, type, kind)), `${piece} / ${catalog}`).toBe(true);
    const same: [string | null, string | null, string?][] = [
      ["Men's L", "Large"],
      ["l", "Large"],
      ["Large", "Men’s Large"],
      ["Black, Large", "Large"],
      ["Trail Team Edition", "Large"],
      ["Trail Team Edition, L/XL", null, "Hat"],
      [null, "Large"],
      ["Men's US 9", "US 9", "Trail runners"],
      ["Women's Large", "Women's", "Fleece"],
      // the ways people type the row's own size
      ["Men's Medium Black", "Men's Medium", "Rain jacket"],
      ["mens medium", "Men's Medium", "Rain jacket"],
      ["Men's 9", "Men's US 9", "Trail runners"],
      ["Men's 8.5", "Men's US 8.5", "Trail runners"],
      ["Men's US9", "Men's US 9", "Trail runners"],
      ["20F Regular Wide", "20F, Regular Wide", "Quilt"],
      ["regular wide", "Regular Wide", "Sleeping pad"],
      ["850fp, 20F", "20F, 850FP", "Quilt"],
      ["Regular, Short, 10F", "10F, Short, Regular", "Quilt"],
      ["pack of 2", "2-pack", "Bungee cord"],
      ["Large/X-Large", "L/XL", "Hat"],
      ["30 liter", "30L", "Backpack"],
      ["Extra Large", "X-Large"],
      // one shoe sold under two labels matches either
      ["Men's US 9", "Men's US 9 / Women's US 10", "Trail runners"],
      ["Women's US 10", "Men's US 9 / Women's US 10", "Trail runners"],
      // the row's own words with a colour after them, the m of a metre kept a metre
      ["Solid inner, carbon short poles Black", "Solid inner, carbon short poles", "Tent"],
      ["1 m", "1m", "Charging cable"],
    ];
    const kindOf = (type?: string) =>
      ({ Quilt: "sleep", "Sleeping pad": "sleep", Backpack: "pack", "Bungee cord": "other", Tent: "shelter", "Charging cable": "electronics" })[type ?? ""];
    for (const [piece, catalog, type] of same) expect(sizeConflict(piece, row(catalog, type, kindOf(type))), `${piece} / ${catalog}`).toBe(false);
  });

  it("say what a kit holds, list its items as pieces of their own, and refuse a weight on one", async () => {
    const added = await tool("edit_my_gear", { add: [{ name: "Pocket stove", weight_g: 73, owned: 2 }, { name: "Cook kit" }] }, aliceWrite);
    const [stoveId, kitId] = (added.data.results as { item: { id: number } }[]).map((r) => r.item.id);
    const [row] = await db.select({ vaultId: schema.vaultItems.vaultId }).from(schema.vaultItems).where(eq(schema.vaultItems.id, stoveId!));
    // made on the gear page; the connector reads it
    expect(await applyVaultItemOp(db, row!.vaultId, { t: "kit", id: kitId!, parts: [{ id: stoveId!, qty: 2 }], ownWeightMg: 20_000 })).not.toBeNull();
    const found = await tool("get_my_gear", { query: "cook kit" }, aliceRead);
    const kit = (found.data.gear as { id: number }[]).find((g) => g.id === kitId);
    expect(kit).toMatchObject({ weight_g: 166, kit: { own_weight_g: 20, items: [{ id: stoveId, count: 2, weight_g: 73, put_away: false }] } });
    expect(kit).not.toHaveProperty("in_kits");
    const stove = ((await tool("get_my_gear", {}, aliceRead)).data.gear as { id: number }[]).find((g) => g.id === stoveId);
    expect(stove).toMatchObject({ in_kits: [kitId] });
    expect(stove).not.toHaveProperty("kit");
    expect(stove).not.toHaveProperty("unweighed");
    // the kit itself is never flagged (its weight is its items'), and nor is a weighed item
    expect(kit).not.toHaveProperty("unweighed");
    expect((kit as unknown as { kit: { items: Record<string, unknown>[] } }).kit.items[0]).not.toHaveProperty("unweighed");
    const refused = await tool("edit_my_gear", { update: [{ id: kitId, weight_g: 500 }] }, aliceWrite);
    expect(refused.refused, refused.text).toBe(false);
    const [answer] = refused.data.updated as { status: string; reason?: string }[];
    expect(answer).toMatchObject({ status: "invalid" });
    expect(answer!.reason).toContain("kit weighs what its items weigh");
  });

  it("make a kit, change what it holds, and turn it back into a piece, as the gear page does", async () => {
    const pieces = await tool("edit_my_gear", { add: [{ name: "Titanium pot", weight_g: 110 }, { name: "Spork", brand: "Toaks", weight_g: 15 }, { name: "Mini lighter", weight_g: 11, owned: 2 }] }, aliceWrite);
    const [potId, sporkId, lighterId] = (pieces.data.results as { item: { id: number } }[]).map((r) => r.item.id);

    // made as it is added: its items by id, with counts, and a weight of its own
    const made = await tool("edit_my_gear", { add: [{ name: "Kitchen kit", kit: { items: [{ id: potId }, { id: sporkId }, { id: lighterId, count: 2 }], own_weight_g: 12 } }] }, aliceWrite);
    expect(made.refused, made.text).toBe(false);
    const [res] = made.data.results as { status: string; item: Record<string, unknown> }[];
    expect(res!.status).toBe("added");
    const kitId = res!.item.id as number;
    expect(res!.item).toMatchObject({ weight_g: 159, kit: { own_weight_g: 12, items: [{ id: potId, count: 1 }, { id: sporkId, count: 1 }, { id: lighterId, count: 2 }] } });

    // never more of a piece than its owned: a higher count is held to it
    const over = await tool("edit_my_gear", { update: [{ id: kitId, kit: { items: [{ id: potId }, { id: sporkId }, { id: lighterId, count: 9 }], own_weight_g: 12 } }] }, aliceWrite);
    expect((over.data.updated as { item: Record<string, unknown> }[])[0]!.item).toMatchObject({ weight_g: 159, kit: { items: [{ id: potId }, { id: sporkId }, { id: lighterId, count: 2 }] } });

    // items REPLACE what it held
    const changed = await tool("edit_my_gear", { update: [{ id: kitId, kit: { items: [{ id: potId }, { id: lighterId, count: 1 }] } }] }, aliceWrite);
    const [up] = changed.data.updated as { status: string; item: Record<string, unknown> }[];
    expect(up).toMatchObject({ status: "updated", item: { weight_g: 121, kit: { own_weight_g: 0, items: [{ id: potId }, { id: lighterId, count: 1 }] } } });
    const spork = ((await tool("get_my_gear", { query: "spork" }, aliceRead)).data.gear as { id: number; in_kits: number[] }[]).find((g) => g.id === sporkId);
    expect(spork).not.toHaveProperty("in_kits");

    // one level deep: a piece already in a kit can't hold items, and a kit can't be an item
    const nested = await tool("edit_my_gear", { update: [{ id: potId, kit: { items: [{ id: sporkId }] } }] }, aliceWrite);
    expect((nested.data.updated as { status: string; reason: string }[])[0]).toMatchObject({ status: "invalid", reason: expect.stringContaining("already in a kit") });
    const kitAsItem = await tool("edit_my_gear", { add: [{ name: "Everything kit", kit: { items: [{ id: kitId }] } }] }, aliceWrite);
    const single = (kitAsItem.data.results as { status: string; reason: string; item: Record<string, unknown> }[])[0];
    expect(single).toMatchObject({ status: "added", reason: expect.stringContaining("Added as a single piece") });
    expect(single!.item).not.toHaveProperty("kit");

    // a malformed kit refuses the whole call before anything is written
    const both = await tool("edit_my_gear", { update: [{ id: kitId, weight_g: 300, kit: { items: [{ id: potId }] } }] }, aliceWrite);
    expect(both.refused).toBe(true);
    expect(both.text).toContain("own_weight_g");
    expect((await tool("edit_my_gear", { add: [{ name: "Empty kit", kit: { items: [] } }] }, aliceWrite)).refused).toBe(true);

    // null turns it back into a piece weighing what the kit did; its items stay pieces
    const undone = await tool("edit_my_gear", { update: [{ id: kitId, kit: null }] }, aliceWrite);
    const piece = (undone.data.updated as { status: string; item: Record<string, unknown> }[])[0];
    expect(piece).toMatchObject({ status: "updated", item: { weight_g: 121 } });
    expect(piece!.item).not.toHaveProperty("kit");
    const notAKit = await tool("edit_my_gear", { update: [{ id: kitId, kit: null }] }, aliceWrite);
    expect((notAKit.data.updated as { status: string; reason: string }[])[0]).toMatchObject({ status: "invalid", reason: expect.stringContaining("isn't a kit") });
    const pot = ((await tool("get_my_gear", { query: "titanium pot" }, aliceRead)).data.gear as { id: number; in_kits: number[]; weight_g: number }[]).find((g) => g.id === potId);
    expect(pot).toMatchObject({ weight_g: 110 });
    expect(pot).not.toHaveProperty("in_kits");
  });

  // The add that started this: a piece with no catalog row, priced, not weighed yet.
  it("add a priced piece not weighed yet, keep its currency when only the price changes, and name a value it can't take", async () => {
    const r = await tool("edit_my_gear", { add: [{ name: "Foray Pants", brand: "Outdoor Research", variant: "Men's Large", gear_type: "Pants", classification: "worn", price: 149.19, currency: "USD", weight_g: 0 }] }, aliceWrite);
    expect(r.refused, r.text).toBe(false);
    const [res] = r.data.results as { status: string; item: Record<string, unknown> }[];
    expect(res).toMatchObject({ status: "added", item: { name: "Foray Pants", weight_g: 0, unweighed: true, classification: "worn", price: 149.19, currency: "USD" } });
    const id = res!.item.id as number;
    // in a kit, the unweighed item says so, since the kit's weight is short by it
    const bag = await tool("edit_my_gear", { add: [{ name: "Clothes bag", kit: { items: [{ id }] } }] }, aliceWrite);
    const bagged = (bag.data.results as { item: { kit: { items: Record<string, unknown>[] } } }[])[0]!.item;
    expect(bagged.kit.items[0]).toMatchObject({ id, weight_g: 0, unweighed: true });
    expect(bagged).not.toHaveProperty("unweighed");
    const repriced = await tool("edit_my_gear", { update: [{ id, price: 120 }] }, aliceWrite);
    expect((repriced.data.updated as { item: Record<string, unknown> }[])[0]!.item).toMatchObject({ price: 120, currency: "USD" });
    // null still clears the price and its currency together
    const cleared = await tool("edit_my_gear", { update: [{ id, price: null }] }, aliceWrite);
    const unpriced = (cleared.data.updated as { item: Record<string, unknown> }[])[0]!.item;
    expect(unpriced).not.toHaveProperty("price");
    expect(unpriced).not.toHaveProperty("currency");

    // a value outside its set is named, and nothing of that piece is written
    const bad = await tool("edit_my_gear", { add: [{ name: "Wind shirt", classification: "Worn" }], update: [{ id, weight_g: "410" }] }, aliceWrite);
    expect(bad.refused, bad.text).toBe(false);
    expect((bad.data.results as { status: string; reason: string }[])[0]).toMatchObject({ status: "invalid", reason: expect.stringContaining("isn't a classification") });
    expect((bad.data.updated as { status: string; reason: string }[])[0]).toMatchObject({ status: "invalid", reason: expect.stringContaining("weight_g") });
    expect((await tool("get_my_gear", { query: "wind shirt" }, aliceRead)).data.gear).toEqual([]);
    expect((await tool("edit_my_gear", { add: [{ brand: "Nameless" }] }, aliceWrite)).data.results).toMatchObject([{ status: "invalid", reason: expect.stringContaining("needs a name") }]);
  });

  // One call can name a piece more than once, and each entry is judged against what
  // the one before it left, not against how the piece stood when the call arrived:
  // the currency a price keeps, whether there is a kit to turn back, whether a weight
  // is a kit's to take.
  it("judge a piece named twice in one update by what the earlier entry left", async () => {
    // names no other case here uses: an add of a piece the account holds answers with that piece
    const added = await tool("edit_my_gear", { add: [{ name: "Twice-named can", weight_g: 200 }, { name: "Twice-named burner", weight_g: 80 }, { name: "Twice-named screen", weight_g: 30 }] }, aliceWrite);
    expect((added.data.results as { status: string }[]).map((r) => r.status)).toEqual(["added", "added", "added"]);
    const [canId, stoveId, screenId] = (added.data.results as { item: { id: number } }[]).map((r) => r.item.id);

    const r = await tool(
      "edit_my_gear",
      {
        update: [
          // priced in euros, then repriced with no currency named: the first entry's stands
          { id: canId, price: 10, currency: "EUR" },
          { id: canId, price: 12 },
          // made a kit; then a weight, which a kit can't take; then turned back, twice
          { id: stoveId, kit: { items: [{ id: screenId }] } },
          { id: stoveId, weight_g: 500 },
          { id: stoveId, kit: null },
          { id: stoveId, kit: null },
          // an id that is nobody's, and the first piece once more
          { id: 999_999, weight_g: 1 },
          { id: canId, price: null },
          { id: canId, price: 3 },
        ],
      },
      aliceWrite,
    );
    expect(r.refused, r.text).toBe(false);
    const updated = r.data.updated as { id: number; status: string; reason?: string; item?: Record<string, unknown> }[];
    expect(updated.map((u) => [u.id, u.status, u.reason])).toEqual([
      [canId, "updated", undefined],
      [canId, "updated", undefined],
      [stoveId, "updated", undefined],
      [stoveId, "invalid", "That is a kit, and a kit weighs what its items weigh: give kit.own_weight_g for what it weighs by itself, or change an item's weight. Nothing was changed on it."],
      [stoveId, "updated", undefined],
      [stoveId, "invalid", "That piece isn't a kit, so there is nothing to turn back. Nothing was changed on it."],
      [999_999, "not_found", undefined],
      [canId, "updated", undefined],
      [canId, "updated", undefined],
    ]);
    expect(updated[0]!.item).toMatchObject({ price: 10, currency: "EUR" });
    expect(updated[1]!.item).toMatchObject({ price: 12, currency: "EUR" });
    expect(updated[2]!.item).toMatchObject({ weight_g: 30, kit: { own_weight_g: 0, items: [{ id: screenId, count: 1 }] } });
    expect(updated[4]!.item).toMatchObject({ weight_g: 30 });
    expect(updated[4]!.item).not.toHaveProperty("kit");
    // cleared, then priced again: no currency is left for the new price to keep
    expect(updated[7]!.item).not.toHaveProperty("price");
    expect(updated[8]!.item).toMatchObject({ price: 3 });
    expect(updated[8]!.item).not.toHaveProperty("currency");
    // the answer is the same JSON twice, as every tool's is
    expect(r.text).toBe(JSON.stringify(r.data));
  });

  // What an update asks of its pieces beforehand (is it there, is it a kit, what currency
  // is its price in) is ONE read for the call. Asked piece by piece it was two round
  // trips each, on a driver that sends every statement as its own request, and the tool
  // takes fifty pieces. Counted here as what each further piece adds to a call: the one
  // read that hands its changed row back with its kits, and nothing before it.
  it("read what an update needs of its pieces once for the call, not once for each", async () => {
    const added = await tool("edit_my_gear", { add: [1, 2, 3, 4].map((n) => ({ name: `Counted piece ${n}`, weight_g: 10 })) }, aliceWrite);
    const ids = (added.data.results as { status: string; item: { id: number } }[]).map((r) => r.item.id);
    expect(new Set(ids).size).toBe(4);

    /** how many reads one edit_my_gear call makes, every entry of it landing */
    const readsFor = async (update: { id: number; weight_g: number }[]) => {
      const reads = vi.spyOn(db, "select");
      try {
        const r = await tool("edit_my_gear", { update }, aliceWrite);
        expect((r.data.updated as { status: string }[]).map((u) => u.status)).toEqual(update.map(() => "updated"));
        return reads.mock.calls.length;
      } finally {
        reads.mockRestore();
      }
    };
    const one = await readsFor([{ id: ids[0]!, weight_g: 11 }]);
    const four = await readsFor(ids.map((id) => ({ id, weight_g: 12 })));
    // three more pieces, three more reads
    expect(four - one).toBe(3);
  });

  it("file catalog food as consumable, and link a kit to the catalog without taking the product's weight", async () => {
    const food = await tool("edit_my_gear", { add: [{ catalog_id: 2 }] }, aliceWrite);
    expect((food.data.results as { item: Record<string, unknown> }[])[0]!.item).toMatchObject({ name: "Builders Bar", classification: "consumable", weight_g: 68, kcal: 290 });

    const parts = await tool("edit_my_gear", { add: [{ name: "Tent stakes", weight_g: 60 }, { name: "Duplex kit" }] }, aliceWrite);
    const [stakesId, kitId] = (parts.data.results as { item: { id: number } }[]).map((r) => r.item.id);
    const linked = await tool("edit_my_gear", { update: [{ id: kitId, name: "Duplex kit", kit: { items: [{ id: stakesId }] }, catalog_id: 1 }] }, aliceWrite);
    const [up] = linked.data.updated as { status: string; item: Record<string, unknown>; reason?: string }[];
    expect(up, up?.reason).toMatchObject({ status: "updated", item: { name: "Duplex kit", catalog_id: 1, weight_g: 60, kit: { items: [{ id: stakesId }] } } });
    // and a kit that already is one takes a link alone, still weighing its items
    const relinked = await tool("edit_my_gear", { update: [{ id: kitId, catalog_id: null }] }, aliceWrite);
    const unlinkedKit = (relinked.data.updated as { status: string; item: Record<string, unknown> }[])[0];
    expect(unlinkedKit).toMatchObject({ status: "updated", item: { weight_g: 60 } });
    expect(unlinkedKit!.item).not.toHaveProperty("catalog_id");
    const again = await tool("edit_my_gear", { update: [{ id: kitId, catalog_id: 1 }] }, aliceWrite);
    expect((again.data.updated as { status: string; item: Record<string, unknown> }[])[0]).toMatchObject({ status: "updated", item: { catalog_id: 1, weight_g: 60 } });
  });

  it("answer an add the account already holds with that piece, so its id is in hand", async () => {
    const again = await tool("edit_my_gear", { add: [{ name: "Titanium pot" }] }, aliceWrite);
    const [res] = again.data.results as { status: string; item: Record<string, unknown> }[];
    expect(res).toMatchObject({ status: "already_have", item: { name: "Titanium pot", weight_g: 110 } });
  });

  it("charge the account's budget rather than the caller's address", async () => {
    vi.mocked(rateLimitSubject).mockClear();
    await tool("get_my_gear", {}, aliceRead);
    await tool("edit_my_gear", { add: [{ name: "Spork" }] }, aliceWrite);
    expect(vi.mocked(rateLimitSubject).mock.calls).toEqual([["mcp-read", `gear:${alice}`], ["mcp-write", `gear:${alice}`]]);
  });

  it("stop working the moment the token is revoked, singly or with the account", async () => {
    expect(await revokeAllAccessTokens(db, alice)).toBe(2);
    expect((await door("get_my_gear", {}, aliceWrite)).status).toBe(401);
    await deleteAccount(db, bob, { deleteLists: false });
    expect(await db.select().from(schema.accessTokens)).toHaveLength(0);
    expect((await door("get_my_gear", {}, bobWrite)).status).toBe(401);
  });
});

// A list made through create_list is filed under the connector's account the way the
// browser files one made while signed in, so the owner finds it wherever they sign in.
// A third account, so the gear this folds into My Gear touches none of the above.
describe("create_list filing under the token's account", () => {
  let carol = 0;
  let carolWrite = "";
  let carolRead = "";
  beforeAll(async () => {
    [carol] = (await db.insert(schema.users).values([{ email: "carol@example.com" }]).returning()).map((u) => u.id);
    carolWrite = (await mintAccessToken(db, carol, { scope: "write", unproven: false }))!.token;
    carolRead = (await mintAccessToken(db, carol, { scope: "read", unproven: false }))!.token;
  });
  afterEach(() => vi.restoreAllMocks());

  const LIST = { title: "Wonderland", items: [{ name: "Lone Peak 8", brand: "Altra", weight_g: 590, classification: "worn" }] };
  const filed = async () => (await listClaimedLists(db, carol)).map((l) => l.shareCode);
  // the list made with no token below: filed under nobody, held by its edit link alone
  let strayCode = "";
  let strayEditLink = "";

  it("files the list with a read-and-change token, and its gear lands in My Gear", async () => {
    const r = await tool("create_list", LIST, carolWrite);
    expect(r.refused, r.text).toBe(false);
    expect(r.data.saved_to_account).toBe(true);
    expect(r.data).not.toHaveProperty("account_note");
    expect(await filed()).toContain(r.data.share_code);
    expect(names(await tool("get_my_gear", {}, carolRead))).toContain("Lone Peak 8");
  });

  it("makes an anonymous list, with no note, when no token is sent", async () => {
    const r = await tool("create_list", LIST);
    expect(r.refused, r.text).toBe(false);
    expect(r.data.saved_to_account).toBe(false);
    expect(r.data).not.toHaveProperty("account_note");
    expect(r.data.edit_link).toContain("/e/");
    expect(await filed()).not.toContain(r.data.share_code);
    strayCode = r.data.share_code as string;
    strayEditLink = r.data.edit_link as string;
  });

  it("makes the list anyway when the token is dead, and says so beside the link", async () => {
    const r = await tool("create_list", LIST, NEVER_MINTED);
    expect(r.refused, r.text).toBe(false);
    expect(r.data.edit_link).toContain("/e/");
    expect(r.data.saved_to_account).toBe(false);
    expect(r.data.account_note).toContain("no longer opens");
    expect(await filed()).not.toContain(r.data.share_code);
  });

  it("asks an app whose access token has aged out to refresh, rather than making the list unfiled", async () => {
    const app = await issueAppTokens(db, { userId: carol, clientId: "https://claude.ai/oauth/claude-code-client-metadata", label: "Claude", scope: "write", unproven: false });
    await db.update(schema.accessTokens).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(schema.accessTokens.refreshHash, sha256Hex(app.refresh_token)));
    const r = await door("create_list", LIST, app.access_token);
    expect(r.status).toBe(401);
    expect(r.challenge).toContain('error="invalid_token"');
    await db.delete(schema.accessTokens).where(eq(schema.accessTokens.refreshHash, sha256Hex(app.refresh_token)));
  });

  it("leaves the list unfiled under a read-only token, and says so", async () => {
    const r = await tool("create_list", LIST, carolRead);
    expect(r.refused, r.text).toBe(false);
    expect(r.data.saved_to_account).toBe(false);
    expect(r.data.account_note).toContain("read-only");
    expect(await filed()).not.toContain(r.data.share_code);
  });

  it("hands back the edit link even when filing fails outright", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    // the account's create budget is spent first, then the claim's, which fails
    vi.mocked(rateLimitSubject).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Too many requests"));
    const r = await tool("create_list", LIST, carolWrite);
    expect(r.refused, r.text).toBe(false);
    expect(r.data.edit_link).toContain("/e/");
    expect(r.data.saved_to_account).toBe(false);
    expect(r.data.account_note).toContain("edit link");
    expect(quiet).toHaveBeenCalled();
    expect(await filed()).not.toContain(r.data.share_code);
  });

  // What was filed above is what get_list with no share code names: the one list made
  // under the write token, by share code and link, and none of the lists made beside it.
  it("names the filed lists to a read token, by share code, and nothing to an account that has none", async () => {
    const none = await door("get_list", {});
    expect(none.status).toBe(401);
    expect(none.challenge).toContain('scope="write"');

    const r = await tool("get_list", {}, carolRead);
    expect(r.refused, r.text).toBe(false);
    const lists = r.data.lists as Record<string, unknown>[];
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ title: "Wonderland", unit: "g", total_g: 590 });
    expect(lists[0]!.share_link).toBe(`http://mahonia.test/s/${lists[0]!.share_code}`);
    expect(JSON.stringify(r.data)).not.toContain("/e/");
    expect(lists.map((l) => l.share_code)).toEqual(await filed());
    // the share code is the read capability, so the list opens from here
    expect((await tool("get_list", { share_code: lists[0]!.share_code })).data.title).toBe("Wonderland");

    const [dave] = (await db.insert(schema.users).values([{ email: "dave@example.com" }]).returning()).map((u) => u.id);
    const daveRead = (await mintAccessToken(db, dave!, { scope: "read", unproven: false }))!.token;
    expect((await tool("get_list", {}, daveRead)).data).toEqual({ lists: [] });
  });

  // A filed list can be changed by its share code under read-and-change access, the way
  // the site lets a signed-in owner edit one without the link. The door asks for that
  // access, as it does for gear; any other list still takes its edit link, which keeps
  // working with no sign-in at all; and nothing hands an edit token back.
  it("changes a filed list by share code with read-and-change access, and no other list", async () => {
    const [mine] = (await tool("get_list", {}, carolRead)).data.lists as { share_code: string }[];
    const code = mine!.share_code;
    const none = await door("edit_list", { share_code: code, add: [{ name: "Spork" }] });
    expect(none.status).toBe(401);
    expect(none.challenge).toContain('scope="write"');
    const readOnly = await door("edit_list", { share_code: code, list: { title: "Nope" } }, carolRead);
    expect(readOnly.status).toBe(403);
    expect(readOnly.error).toBe("insufficient_scope");

    vi.mocked(rateLimitSubject).mockClear();
    const added = await tool("edit_list", { share_code: code, add: [{ name: "Spork", weight_g: 10 }] }, carolWrite);
    expect(added.refused, added.text).toBe(false);
    expect(added.data.added).toBe(1);
    expect(JSON.stringify(added.data)).not.toContain("/e/");
    // the budget is the account's, as it is for gear, never the shared address
    expect(vi.mocked(rateLimitSubject).mock.calls[0]).toEqual(["mcp-write", `lists:${carol}`]);
    const titled = await tool("edit_list", { share_code: `http://mahonia.test/s/${code}`, list: { title: "Wonderland Trail" } }, carolWrite);
    expect(titled.refused, titled.text).toBe(false);
    const read = await tool("get_list", { share_code: code });
    expect(read.data.title).toBe("Wonderland Trail");
    expect(JSON.stringify(read.data)).toContain("Spork");

    // a list the account has not filed answers as one that doesn't exist…
    const notMine = await tool("edit_list", { share_code: strayCode, remove: ["x"] }, carolWrite);
    expect(notMine.refused).toBe(true);
    expect(notMine.text).toContain("filed under this account");
    expect((await tool("edit_list", { share_code: "ZZZZZZZZZZZZ", folders: [{ folder: "x", name: "y" }] }, carolWrite)).text).toBe(notMine.text);
    // …and its edit link still opens it, with no sign-in at all
    const byLink = await tool("edit_list", { edit_link: strayEditLink, add: [{ name: "Spoon" }] });
    expect(byLink.refused, byLink.text).toBe(false);
    // an edit link given beside a share code is the one used, and no sign-in is asked for
    expect((await tool("edit_list", { edit_link: strayEditLink, share_code: code, list: { title: "Stray" } })).refused).toBe(false);
    expect((await tool("get_list", { share_code: strayCode })).data.title).toBe("Stray");
    expect((await tool("get_list", { share_code: code })).data.title).toBe("Wonderland Trail");
  });
});

// A create_list that timed out is retried by the client with the same arguments, and
// nothing in the protocol marks it. From an account with read-and-change access the
// retry is answered with the list the first call made, which that account can change by
// share code, and never with an edit link the server would have had to keep a copy of.
// Anonymous and read-only callers still get a second list: see REPLAY_WINDOW_S.
describe("create_list retried by the same account", () => {
  let erin = 0;
  let erinWrite = "";
  let erinRead = "";
  beforeAll(async () => {
    [erin] = (await db.insert(schema.users).values([{ email: "erin@example.com" }]).returning()).map((u) => u.id);
    erinWrite = (await mintAccessToken(db, erin, { scope: "write", unproven: false }))!.token;
    erinRead = (await mintAccessToken(db, erin, { scope: "read", unproven: false }))!.token;
  });
  const LIST = { title: "Enchantments", items: [{ name: "Quilt", weight_g: 600 }] };
  const filed = async () => (await listClaimedLists(db, erin)).map((l) => l.shareCode);

  const replayKeys = () => [...kv.keys()].filter((k) => k.startsWith("mcp:replay:"));

  it("answers the repeat with the list already made, no second list and no edit link", async () => {
    const first = await tool("create_list", LIST, erinWrite);
    expect(first.refused, first.text).toBe(false);
    expect(first.data).toMatchObject({ saved_to_account: true, repeated: false });
    expect(first.data.edit_link).toContain("/e/");
    // kept ten minutes in the store, and nothing in it is the edit link
    const [key] = replayKeys();
    expect(ttls.get(key!)).toBe(600);
    expect(JSON.stringify(kv.get(key!))).not.toContain("/e/");
    const retry = await tool("create_list", LIST, erinWrite);
    expect(retry.refused, retry.text).toBe(false);
    expect(retry.data).toMatchObject({ share_code: first.data.share_code, saved_to_account: true, repeated: true, items: 1 });
    expect(retry.data).not.toHaveProperty("edit_link");
    expect(JSON.stringify(retry.data)).not.toContain("/e/");
    expect(retry.text).toContain("no second list");
    expect(await filed()).toEqual([first.data.share_code]);
    // what the repeat names, the account changes by share code, and a later repeat reads
    // the list as it now is
    const renamed = await tool("edit_list", { share_code: retry.data.share_code, list: { title: "Enchantments loop" } }, erinWrite);
    expect(renamed.refused, renamed.text).toBe(false);
    expect((await tool("create_list", LIST, erinWrite)).data).toMatchObject({ repeated: true, title: "Enchantments loop" });
  });

  it("keeps one account's window from another's", async () => {
    const [frank] = (await db.insert(schema.users).values([{ email: "frank@example.com" }]).returning()).map((u) => u.id);
    const frankWrite = (await mintAccessToken(db, frank!, { scope: "write", unproven: false }))!.token;
    const mine = await tool("create_list", LIST, erinWrite);
    const theirs = await tool("create_list", LIST, frankWrite);
    expect(theirs.data).toMatchObject({ repeated: false, saved_to_account: true });
    expect(theirs.data.share_code).not.toBe(mine.data.share_code);
  });

  it("makes a new list when the one the window names was deleted or taken off the account", async () => {
    const first = await tool("create_list", LIST, erinWrite);
    // off the account (as rotating its link does), the list itself untouched
    const [{ id: firstId }] = await db.select({ id: schema.lists.id }).from(schema.lists).where(eq(schema.lists.shareCode, first.data.share_code as string));
    await db.delete(schema.listClaims).where(eq(schema.listClaims.listId, firstId!));
    const second = await tool("create_list", LIST, erinWrite);
    expect(second.data).toMatchObject({ repeated: false, saved_to_account: true });
    expect(second.data.share_code).not.toBe(first.data.share_code);
    await db.update(schema.lists).set({ deletedAt: new Date() }).where(eq(schema.lists.shareCode, second.data.share_code as string));
    const third = await tool("create_list", LIST, erinWrite);
    expect(third.data).toMatchObject({ repeated: false });
    expect(third.data.share_code).not.toBe(second.data.share_code);
    // and the window now names the newest, which a retry gets
    expect((await tool("create_list", LIST, erinWrite)).data).toMatchObject({ repeated: true, share_code: third.data.share_code });
  });

  it("remembers nothing from a create whose list couldn't be filed", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(rateLimitSubject).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Too many requests"));
    const unfiled = await tool("create_list", LIST, erinWrite);
    expect(unfiled.data).toMatchObject({ saved_to_account: false, repeated: false });
    quiet.mockRestore();
    const retry = await tool("create_list", LIST, erinWrite);
    expect(retry.data).toMatchObject({ saved_to_account: true, repeated: false });
    expect(retry.data.share_code).not.toBe(unfiled.data.share_code);
  });

  // A retry that lands while the first call is still running waits for its answer,
  // and says the list is on its way when that takes longer than the wait.
  it("waits on an identical create still running, and says so when it runs long", async () => {
    const was = { ...REPLAY_WAIT };
    Object.assign(REPLAY_WAIT, { totalMs: 2_000, stepMs: 5 });
    try {
      const first = await tool("create_list", LIST, erinWrite);
      const [key] = replayKeys();
      const done = kv.get(key!);
      // as the first call's claim reads while its write is under way
      kv.set(key!, { at: Date.now(), pending: true });
      setTimeout(() => kv.set(key!, done), 30);
      expect((await tool("create_list", LIST, erinWrite)).data).toMatchObject({ repeated: true, share_code: first.data.share_code });
      Object.assign(REPLAY_WAIT, { totalMs: 20 });
      kv.set(key!, { at: Date.now(), pending: true });
      const busy = await tool("create_list", LIST, erinWrite);
      expect(busy.refused).toBe(true);
      expect(busy.text).toContain("still being made");
      // a claim whose call died lapses after a minute, and the next call makes the list
      kv.set(key!, { at: Date.now() - 61_000, pending: true });
      expect((await tool("create_list", LIST, erinWrite)).data).toMatchObject({ repeated: false });
    } finally {
      Object.assign(REPLAY_WAIT, was);
    }
  });

  it("makes the same list twice when asked to with again, and keys on the whole call", async () => {
    const first = await tool("create_list", LIST, erinWrite);
    const twice = await tool("create_list", { ...LIST, again: true }, erinWrite);
    expect(twice.data).toMatchObject({ repeated: false });
    expect(twice.data.share_code).not.toBe(first.data.share_code);
    expect(twice.data.edit_link).toContain("/e/");
    // again neither reads nor writes the window: a plain retry still gets the first
    expect((await tool("create_list", LIST, erinWrite)).data).toMatchObject({ repeated: true, share_code: first.data.share_code });
    // a different call is a different list
    const other = await tool("create_list", { ...LIST, title: "Enchantments, day 2" }, erinWrite);
    expect(other.data.repeated).toBe(false);
    expect(other.data.share_code).not.toBe(first.data.share_code);
    expect((await tool("create_list", { ...LIST, again: "yes" }, erinWrite)).text).toContain("again must be true or false");
  });

  it("holds no window for a list with no rows, which two conversations often ask for alike", async () => {
    const a = await tool("create_list", { title: "PCT" }, erinWrite);
    const b = await tool("create_list", { title: "PCT" }, erinWrite);
    expect(b.data).toMatchObject({ repeated: false, saved_to_account: true });
    expect(b.data.share_code).not.toBe(a.data.share_code);
    expect(replayKeys()).toEqual([]);
  });

  it("holds no window for an anonymous or a read-only caller, whose lists aren't filed", async () => {
    for (const token of [undefined, erinRead]) {
      const a = await tool("create_list", LIST, token);
      const b = await tool("create_list", LIST, token);
      expect(b.refused, b.text).toBe(false);
      expect(b.data).toMatchObject({ repeated: false, saved_to_account: false });
      expect(b.data.share_code).not.toBe(a.data.share_code);
      expect(b.data.edit_link).toContain("/e/");
    }
  });
});
