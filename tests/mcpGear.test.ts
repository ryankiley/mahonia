import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import {
  ACCESS_TOKENS_MAX,
  ACCESS_TOKEN_PREFIX,
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
import { LISTS_DDL } from "../server/utils/db";
import { rateLimitSubject } from "../server/utils/rateLimit";
import { VAULT_DDL } from "../server/utils/vaultSchema";
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
vi.mock("../server/utils/rateLimit", () => ({
  rateLimit: async () => {},
  rateLimitSubject: vi.fn(async () => {}),
  useKv: () => ({ getItem: async () => null, setItem: async () => {} }),
}));
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
  await db.insert(schema.catalogItems).values([{ brand: "Zpacks", name: "Duplex", variant: null, weightMg: 538_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/duplex", verified: true, commonName: "Tent", categoryHint: "shelter", searchTerms: "tent shelter" }]);
  [alice, bob] = (await db.insert(schema.users).values([{ email: "alice@example.com" }, { email: "bob@example.com" }]).returning()).map((u) => u.id);
  aliceRead = (await mintAccessToken(db, alice, { label: "Reader", scope: "read" }))!.token;
  aliceWrite = (await mintAccessToken(db, alice, { label: "Claude Code", scope: "write" }))!.token;
  bobWrite = (await mintAccessToken(db, bob, { scope: "write" }))!.token;
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
    const spare = (await mintAccessToken(db, alice, { scope: "read" }))!;
    expect(await revokeAccessToken(db, bob, spare.id)).toBe(false);
    expect(await resolveBearer(db, spare.token)).not.toBeNull();
    expect(await revokeAccessToken(db, alice, spare.id)).toBe(true);
    expect(await resolveBearer(db, spare.token)).toBeNull();
  });

  it("refuses the token past the ceiling", async () => {
    // bob holds one already, so the ceiling is reached one mint early
    const minted = [];
    for (let i = 0; i < ACCESS_TOKENS_MAX; i++) minted.push(await mintAccessToken(db, bob, { scope: "read" }));
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
    expect(none.challenge).toContain('scope="read"');
    // a write tool asks for the write scope up front, so the consent is right first time
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
    expect(r.data).toEqual({ gear: [], folders: [], total: 0, offset: 0 });
  });

  it("let a read-only token change nothing, not even mint the vault: a 403 that asks for write", async () => {
    const r = await door("edit_my_gear", { add: [{ name: "X-Mid 2" }] }, aliceRead);
    expect(r.status).toBe(403);
    expect(r.error).toBe("insufficient_scope");
    expect(r.challenge).toContain('Bearer error="insufficient_scope"');
    expect(r.challenge).toContain('scope="write"');
    expect(await db.select().from(schema.vaults)).toHaveLength(0);
  });

  let tentId = 0;
  it("add pieces, file them by folder name, and report a piece the account already holds", async () => {
    const r = await tool(
      "edit_my_gear",
      {
        add: [
          { name: "X-Mid 2", brand: "Durston", gear_type: "Tent", weight_g: 1000, folder: "Shelter", price: 329, currency: "usd" },
          { name: "Flash 55", brand: "REI", variant: "M", weight_g: 1190, folder: "Pack", classification: "base" },
          { name: "" },
        ],
      },
      aliceWrite,
    );
    expect(r.refused, r.text).toBe(false);
    expect(r.data.added).toBe(2);
    const results = r.data.results as { index: number; status: string; item?: Record<string, unknown> }[];
    expect(results.map((x) => x.status)).toEqual(["added", "added", "invalid"]);
    expect(results[0]!.item).toMatchObject({ display_name: "Durston X-Mid 2", gear_type: "Tent", weight_g: 1000, folder: "Shelter", price: 329, currency: "USD" });
    tentId = results[0]!.item!.id as number;

    // identity is brand + name + variant, case-folded; "shelter" is the folder "Shelter"
    const again = await tool("edit_my_gear", { add: [{ name: "x-mid 2", brand: "DURSTON", folder: "shelter" }] }, aliceWrite);
    expect((again.data.results as { status: string }[]).map((x) => x.status)).toEqual(["already_have"]);
    expect((await db.select().from(schema.vaultFolders)).map((f) => f.name).sort()).toEqual(["Pack", "Shelter"]);
  });

  it("pin every field an add gives, so a later list save leaves them alone", async () => {
    const [tent] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, tentId));
    expect(tent).toMatchObject({ namePinned: true, weightPinned: true, commonNamePinned: true, pricePinned: true });
  });

  it("list everything, rank by a query, keep to a folder, and page", async () => {
    const all = await tool("get_my_gear", {}, aliceRead);
    expect(all.data.total).toBe(2);
    expect(all.data.folders).toEqual(["Shelter", "Pack"]);
    expect(names(await tool("get_my_gear", { query: "flash" }, aliceRead))).toEqual(["Flash 55"]);
    expect(names(await tool("get_my_gear", { folder: "PACK" }, aliceRead))).toEqual(["Flash 55"]);
    const nowhere = await tool("get_my_gear", { folder: "Kitchen" }, aliceRead);
    expect(nowhere.refused).toBe(true);
    expect(nowhere.text).toContain("Shelter, Pack");
    const page = await tool("get_my_gear", { limit: 1, offset: 1 }, aliceRead);
    expect(page.data).toMatchObject({ total: 2, offset: 1 });
    expect(page.data.gear).toHaveLength(1);
    expect((await tool("get_my_gear", { query: "x" }, aliceRead)).refused).toBe(true);
  });

  it("change one field, clear another, move the piece between folders, and mark an empty change invalid", async () => {
    const r = await tool("edit_my_gear", { update: [{ id: tentId, weight_g: 1010, price: null, folder: "Big three" }] }, aliceWrite);
    expect(r.refused, r.text).toBe(false);
    const [done] = r.data.updated as { id: number; status: string; item: Record<string, unknown> }[];
    expect(done).toMatchObject({ id: tentId, status: "updated", item: { id: tentId, weight_g: 1010, price: null, currency: null, folder: "Big three" } });
    const unfiled = (await tool("edit_my_gear", { update: [{ id: tentId, folder: "" }] }, aliceWrite)).data.updated as { item: Record<string, unknown> }[];
    expect(unfiled[0]!.item).toMatchObject({ folder: null });
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
    // and the folder named beside a bad id is not made
    await tool("edit_my_gear", { update: [{ id: bobsId, folder: "Stoves" }] }, aliceWrite);
    expect((await db.select().from(schema.vaultFolders)).map((f) => f.name)).not.toContain("Stoves");
  });

  it("put a piece away and bring it back", async () => {
    expect((await tool("edit_my_gear", { remove: [tentId] }, aliceWrite)).data.removed).toEqual([{ id: tentId, status: "removed" }]);
    expect((await tool("get_my_gear", {}, aliceRead)).data.total).toBe(1);
    expect((await tool("edit_my_gear", { remove: [tentId] }, aliceWrite)).data.removed).toEqual([{ id: tentId, status: "not_found" }]);
    expect((await tool("edit_my_gear", { restore: [tentId] }, aliceWrite)).data.removed).toEqual([{ id: tentId, status: "restored" }]);
    expect((await tool("get_my_gear", {}, aliceRead)).data.total).toBe(2);
  });

  it("link a piece to the catalog as it is added or later, taking the catalog's fields where none were given, and unlink", async () => {
    const r = await tool("edit_my_gear", { add: [{ catalog_id: 1, folder: "Shelter" }, { name: "Spare Duplex", catalog_id: 1, weight_g: 90 }] }, aliceWrite);
    expect(r.refused, r.text).toBe(false);
    const results = r.data.results as { status: string; item?: Record<string, unknown> }[];
    expect(results.map((x) => x.status)).toEqual(["added", "added"]);
    // named by the catalog alone: the catalog's brand, name, gear type and weight
    expect(results[0]!.item).toMatchObject({ display_name: "Zpacks Duplex", gear_type: "Tent", weight_g: 538, catalog_id: 1, folder: "Shelter" });
    // the fields given stand over the catalog's; the link is the same
    expect(results[1]!.item).toMatchObject({ name: "Spare Duplex", brand: "Zpacks", weight_g: 90, catalog_id: 1 });
    const duplexId = results[0]!.item!.id as number;
    expect((await tool("get_my_gear", { query: "duplex" }, aliceRead)).data.gear).toHaveLength(2);
    // relinked later: the catalog's name and brand, the owner's weight
    const linked = (await tool("edit_my_gear", { update: [{ id: tentId, catalog_id: 1, weight_g: 1200 }] }, aliceWrite)).data.updated as { status: string; item: Record<string, unknown> }[];
    expect(linked[0]!.status).toBe("updated");
    expect(linked[0]!.item).toMatchObject({ id: tentId, name: "Duplex", brand: "Zpacks", weight_g: 1200, catalog_id: 1 });
    // unlinked: the piece as it reads, with no link
    const unlinked = (await tool("edit_my_gear", { update: [{ id: duplexId, catalog_id: null }] }, aliceWrite)).data.updated as { item: Record<string, unknown> }[];
    expect(unlinked[0]!.item).toMatchObject({ name: "Duplex", weight_g: 538, catalog_id: null });
    // an id that names no catalog row refuses the call before anything is written
    const before = (await tool("get_my_gear", {}, aliceRead)).data.total;
    const refused = await tool("edit_my_gear", { add: [{ name: "x", catalog_id: 404 }], remove: [duplexId] }, aliceWrite);
    expect(refused.refused).toBe(true);
    expect(refused.text).toContain("isn't in the catalog");
    expect((await tool("edit_my_gear", { update: [{ id: duplexId, catalog_id: 1.5 }] }, aliceWrite)).refused).toBe(true);
    expect((await tool("get_my_gear", {}, aliceRead)).data.total).toBe(before);
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
    carolWrite = (await mintAccessToken(db, carol, { scope: "write" }))!.token;
    carolRead = (await mintAccessToken(db, carol, { scope: "read" }))!.token;
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

  it("leaves the list unfiled under a read-only token, and says so", async () => {
    const r = await tool("create_list", LIST, carolRead);
    expect(r.refused, r.text).toBe(false);
    expect(r.data.saved_to_account).toBe(false);
    expect(r.data.account_note).toContain("read-only");
    expect(await filed()).not.toContain(r.data.share_code);
  });

  it("hands back the edit link even when filing fails outright", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(rateLimitSubject).mockRejectedValueOnce(new Error("Too many requests"));
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
    expect(none.challenge).toContain('scope="read"');

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
    const daveRead = (await mintAccessToken(db, dave!, { scope: "read" }))!.token;
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
