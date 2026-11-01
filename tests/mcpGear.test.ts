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
// read, add to, change and put away gear and name the account's lists, while requests
// carrying none, or a dead one, are refused at the door with the 401 that starts a
// sign-in. Three things are held here above all — a token reaches its own account's
// gear and lists and no other's, a read-only token writes nothing, and a revoked token
// is dead on the next call. The sign-in itself is tests/oauth.test.ts.

vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));
vi.mock("../server/utils/rateLimit", () => ({
  rateLimit: async () => {},
  rateLimitSubject: vi.fn(async () => {}),
  useKv: () => ({ getItem: async () => null, setItem: async () => {} }),
}));

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
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL);
  dbState.db = db;
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
    const none = await door("list_my_gear", {});
    expect(none.status).toBe(401);
    expect(none.result).toBeUndefined();
    expect(none.error).toBe("invalid_token");
    expect(none.challenge).toContain('Bearer error="invalid_token"');
    expect(none.challenge).toContain('resource_metadata="http://mahonia.test/.well-known/oauth-protected-resource/mcp"');
    expect(none.challenge).toContain('scope="read"');
    // a write tool asks for the write scope up front, so the consent is right first time
    expect((await door("add_my_gear", { items: [{ name: "x" }] })).challenge).toContain('scope="write"');
    const dead = await door("list_my_gear", {}, NEVER_MINTED);
    expect(dead.status).toBe(401);
    expect(dead.description).toContain("again");
    // a bearer that is not one of ours is not looked up: the connector is anonymous
    const foreign = await door("list_my_gear", {}, "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ABCDE");
    expect(foreign.status).toBe(401);
    expect(foreign.description).toContain("Sign in");
    // and nothing else at the endpoint asks for a credential
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).status).toBe(200);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(200);
  });

  it("read an account that has no gear yet as empty", async () => {
    const r = await tool("list_my_gear", {}, aliceRead);
    expect(r.refused, r.text).toBe(false);
    expect(r.data).toEqual({ gear: [], folders: [], total: 0, offset: 0 });
  });

  it("let a read-only token change nothing, not even mint the vault: a 403 that asks for write", async () => {
    const r = await door("add_my_gear", { items: [{ name: "X-Mid 2" }] }, aliceRead);
    expect(r.status).toBe(403);
    expect(r.error).toBe("insufficient_scope");
    expect(r.challenge).toContain('Bearer error="insufficient_scope"');
    expect(r.challenge).toContain('scope="write"');
    expect(await db.select().from(schema.vaults)).toHaveLength(0);
  });

  let tentId = 0;
  it("add pieces, file them by folder name, and report a piece the account already holds", async () => {
    const r = await tool(
      "add_my_gear",
      {
        items: [
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
    const again = await tool("add_my_gear", { items: [{ name: "x-mid 2", brand: "DURSTON", folder: "shelter" }] }, aliceWrite);
    expect((again.data.results as { status: string }[]).map((x) => x.status)).toEqual(["already_have"]);
    expect((await db.select().from(schema.vaultFolders)).map((f) => f.name).sort()).toEqual(["Pack", "Shelter"]);
  });

  it("pin every field an add gives, so a later list save leaves them alone", async () => {
    const [tent] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, tentId));
    expect(tent).toMatchObject({ namePinned: true, weightPinned: true, commonNamePinned: true, pricePinned: true });
  });

  it("list everything, rank by a query, keep to a folder, and page", async () => {
    const all = await tool("list_my_gear", {}, aliceRead);
    expect(all.data.total).toBe(2);
    expect(all.data.folders).toEqual(["Shelter", "Pack"]);
    expect(names(await tool("list_my_gear", { query: "flash" }, aliceRead))).toEqual(["Flash 55"]);
    expect(names(await tool("list_my_gear", { folder: "PACK" }, aliceRead))).toEqual(["Flash 55"]);
    const nowhere = await tool("list_my_gear", { folder: "Kitchen" }, aliceRead);
    expect(nowhere.refused).toBe(true);
    expect(nowhere.text).toContain("Shelter, Pack");
    const page = await tool("list_my_gear", { limit: 1, offset: 1 }, aliceRead);
    expect(page.data).toMatchObject({ total: 2, offset: 1 });
    expect(page.data.gear).toHaveLength(1);
    expect((await tool("list_my_gear", { query: "x" }, aliceRead)).refused).toBe(true);
  });

  it("change one field, clear another, move the piece between folders, and refuse an empty change", async () => {
    const r = await tool("update_my_gear", { id: tentId, weight_g: 1010, price: null, folder: "Big three" }, aliceWrite);
    expect(r.refused, r.text).toBe(false);
    expect(r.data.item).toMatchObject({ id: tentId, weight_g: 1010, price: null, currency: null, folder: "Big three" });
    expect((await tool("update_my_gear", { id: tentId, folder: "" }, aliceWrite)).data.item).toMatchObject({ folder: null });
    expect((await tool("update_my_gear", { id: tentId, name: null }, aliceWrite)).refused).toBe(true);
    expect((await tool("update_my_gear", { id: tentId }, aliceWrite)).refused).toBe(true);
  });

  it("never reach another account's gear, by id or by listing", async () => {
    const bobs = await tool("add_my_gear", { items: [{ name: "Windburner" }] }, bobWrite);
    const bobsId = (bobs.data.results as { item: { id: number } }[])[0]!.item.id;
    expect((await tool("update_my_gear", { id: bobsId, weight_g: 1 }, aliceWrite)).refused).toBe(true);
    expect((await tool("remove_my_gear", { id: bobsId }, aliceWrite)).refused).toBe(true);
    expect(names(await tool("list_my_gear", {}, aliceWrite))).not.toContain("Windburner");
    // and the folder named beside a bad id is not made
    await tool("update_my_gear", { id: bobsId, folder: "Stoves" }, aliceWrite);
    expect((await db.select().from(schema.vaultFolders)).map((f) => f.name)).not.toContain("Stoves");
  });

  it("put a piece away and bring it back", async () => {
    expect((await tool("remove_my_gear", { id: tentId }, aliceWrite)).data).toEqual({ id: tentId, status: "removed" });
    expect((await tool("list_my_gear", {}, aliceRead)).data.total).toBe(1);
    expect((await tool("remove_my_gear", { id: tentId }, aliceWrite)).refused).toBe(true);
    expect((await tool("remove_my_gear", { id: tentId, restore: true }, aliceWrite)).data).toEqual({ id: tentId, status: "restored" });
    expect((await tool("list_my_gear", {}, aliceRead)).data.total).toBe(2);
  });

  it("charge the account's budget rather than the caller's address", async () => {
    vi.mocked(rateLimitSubject).mockClear();
    await tool("list_my_gear", {}, aliceRead);
    await tool("add_my_gear", { items: [{ name: "Spork" }] }, aliceWrite);
    expect(vi.mocked(rateLimitSubject).mock.calls).toEqual([["mcp-read", `gear:${alice}`], ["mcp-write", `gear:${alice}`]]);
  });

  it("stop working the moment the token is revoked, singly or with the account", async () => {
    expect(await revokeAllAccessTokens(db, alice)).toBe(2);
    expect((await door("list_my_gear", {}, aliceWrite)).status).toBe(401);
    await deleteAccount(db, bob, { deleteLists: false });
    expect(await db.select().from(schema.accessTokens)).toHaveLength(0);
    expect((await door("list_my_gear", {}, bobWrite)).status).toBe(401);
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

  it("files the list with a read-and-change token, and its gear lands in My Gear", async () => {
    const r = await tool("create_list", LIST, carolWrite);
    expect(r.refused, r.text).toBe(false);
    expect(r.data.saved_to_account).toBe(true);
    expect(r.data).not.toHaveProperty("account_note");
    expect(await filed()).toContain(r.data.share_code);
    expect(names(await tool("list_my_gear", {}, carolRead))).toContain("Lone Peak 8");
  });

  it("makes an anonymous list, with no note, when no token is sent", async () => {
    const r = await tool("create_list", LIST);
    expect(r.refused, r.text).toBe(false);
    expect(r.data.saved_to_account).toBe(false);
    expect(r.data).not.toHaveProperty("account_note");
    expect(r.data.edit_link).toContain("/e/");
    expect(await filed()).not.toContain(r.data.share_code);
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

  // What was filed above is what get_my_lists names: the one list made under the
  // write token, by share code and link, and none of the lists made beside it.
  it("names the filed lists to a read token, by share code, and nothing to an account that has none", async () => {
    const none = await door("get_my_lists", {});
    expect(none.status).toBe(401);
    expect(none.challenge).toContain('scope="read"');

    const r = await tool("get_my_lists", {}, carolRead);
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
    expect((await tool("get_my_lists", {}, daveRead)).data).toEqual({ lists: [] });
  });
});
