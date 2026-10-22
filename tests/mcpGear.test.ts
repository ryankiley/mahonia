import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createEvent } from "h3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../server/db/schema";
import mcp from "../server/routes/mcp.post";
import {
  ACCESS_TOKENS_MAX,
  createAccessToken,
  listAccessTokens,
  resolveAccessToken,
  revokeAccessToken,
  revokeAllAccessTokens,
} from "../server/utils/accessTokens";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { deleteAccount } from "../server/utils/accountRepo";
import { LISTS_DDL } from "../server/utils/db";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { createTestDb } from "./helpers/db";
import { expectResultConforms } from "./helpers/mcpSchema";

// My Gear over MCP, end to end against a real (in-memory) database: an account mints
// access tokens, and an assistant carrying one reads, adds, changes and puts away the
// account's gear through the same JSON-RPC endpoint the list tools use. What is pinned
// here is the token's reach (its own account, its own scope, gone once revoked) and that
// a connector without one is told how to get one instead of being refused at the door.

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../server/utils/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../server/utils/db")>();
  const grab = async () => state.db;
  return { ...mod, useDb: grab, useCatalogDb: grab, useVaultDb: grab, useAccountDb: grab };
});
vi.mock("../server/utils/rateLimit", () => ({
  rateLimit: async () => {},
  rateLimitSubject: async () => {},
  useKv: () => ({ getItem: async () => null, setItem: async () => {} }),
}));

type Result = { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean };

async function rpc(method: string, params: unknown, token?: string) {
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  req.url = "/mcp";
  const buf = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  req.headers = {
    host: "mahonia.test",
    "content-type": "application/json",
    "content-length": String(buf.length),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  req.push(buf);
  req.push(null);
  const event = createEvent(req, new ServerResponse(req));
  const out = (await mcp(event)) as { result?: Result };
  return { status: event.node.res.statusCode, result: out.result! };
}
const call = async (name: string, args: unknown, token?: string) => {
  const { status, result } = await rpc("tools/call", { name, arguments: args }, token);
  expectResultConforms(name, result);
  return { status, data: result.structuredContent as Record<string, unknown>, text: result.content[0]!.text, isError: result.isError ?? false };
};

type Db = Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let me = 0;
let stranger = 0;
let readToken = "";
let writeToken = "";
let strangerToken = "";

beforeAll(async () => {
  db = await createTestDb(LISTS_DDL, ACCOUNT_DDL, VAULT_DDL);
  state.db = db;
  [me, stranger] = (
    await db.insert(schema.users).values([{ email: "me@example.com" }, { email: "them@example.com" }]).returning()
  ).map((u) => u.id);
  readToken = (await createAccessToken(db, me, { label: "Reader", scope: "read" }))!.token;
  writeToken = (await createAccessToken(db, me, { label: "Claude Code", scope: "write" }))!.token;
  strangerToken = (await createAccessToken(db, stranger, { scope: "write" }))!.token;
});

describe("access tokens", () => {
  it("are stored as a hash, carry their scope, and resolve to their account", async () => {
    expect(writeToken).toMatch(/^pack_[A-Za-z0-9_-]{40,}$/);
    const rows = await db.select().from(schema.accessTokens);
    expect(rows.some((r) => r.tokenHash === writeToken || r.tokenHash.includes(writeToken))).toBe(false);
    expect(await resolveAccessToken(db, writeToken)).toEqual({ userId: me, scope: "write" });
    expect(await resolveAccessToken(db, readToken)).toEqual({ userId: me, scope: "read" });
    expect(await resolveAccessToken(db, "pack_never-issued")).toBeNull();
  });

  it("list without their value, and stamp their first use", async () => {
    const listed = await listAccessTokens(db, me);
    expect(listed.map((t) => [t.label, t.scope])).toEqual(
      expect.arrayContaining([["Reader", "read"], ["Claude Code", "write"]]),
    );
    expect(JSON.stringify(listed)).not.toContain(writeToken);
    expect(listed.every((t) => t.lastUsedAt)).toBe(true); // resolved in the case above
  });

  it("revoke only within their own account", async () => {
    const extra = (await createAccessToken(db, me, { scope: "read" }))!;
    expect(await revokeAccessToken(db, stranger, extra.id)).toBe(false);
    expect(await resolveAccessToken(db, extra.token)).not.toBeNull();
    expect(await revokeAccessToken(db, me, extra.id)).toBe(true);
    expect(await resolveAccessToken(db, extra.token)).toBeNull();
  });

  it("stop at the per-account ceiling", async () => {
    const made = [];
    for (let i = 0; i < ACCESS_TOKENS_MAX; i++) made.push(await createAccessToken(db, stranger, { scope: "read" }));
    // the stranger already held one, so the last of these is one too many
    expect(made.filter(Boolean)).toHaveLength(ACCESS_TOKENS_MAX - 1);
    expect(made.at(-1)).toBeNull();
    // back to the one write token the gear cases below use
    for (const t of await listAccessTokens(db, stranger)) if (t.scope === "read") await revokeAccessToken(db, stranger, t.id);
    expect(await listAccessTokens(db, stranger)).toHaveLength(1);
  });
});

describe("My Gear over MCP", () => {
  it("tells a connector with no token how to get one, without refusing it at the door", async () => {
    const r = await call("list_my_gear", {});
    expect(r.status).toBe(200);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("http://mahonia.test/account");
    expect(r.text).toContain("Authorization: Bearer");
    const dead = await call("list_my_gear", {}, "pack_revoked-or-made-up");
    expect(dead.isError).toBe(true);
    expect(dead.text).toMatch(/revoked/);
  });

  it("reads an empty My Gear before the account has any", async () => {
    const r = await call("list_my_gear", {}, readToken);
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toEqual({ gear: [], folders: [], total: 0, offset: 0 });
  });

  it("keeps a read-only token from changing anything", async () => {
    const r = await call("add_my_gear", { items: [{ name: "Duplex" }] }, readToken);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/only read/);
    expect(await db.select().from(schema.vaults)).toHaveLength(0);
  });

  let duplexId = 0;
  it("adds gear, files it by folder name, and reports what it already had", async () => {
    const r = await call(
      "add_my_gear",
      {
        items: [
          { name: "Duplex", brand: "Zpacks", gear_type: "Tent", weight_g: 538, folder: "Shelter", price: 699, currency: "usd" },
          { name: "Revelation", brand: "Enlightened Equipment", variant: "20F Long", weight_g: 590, folder: "Sleep", classification: "base" },
          { name: "  " },
        ],
      },
      writeToken,
    );
    expect(r.isError, r.text).toBe(false);
    expect(r.data.added).toBe(2);
    const results = r.data.results as { index: number; status: string; item?: Record<string, unknown> }[];
    expect(results.map((x) => x.status)).toEqual(["added", "added", "invalid"]);
    expect(results[0]!.item).toMatchObject({ display_name: "Zpacks Duplex", weight_g: 538, folder: "Shelter", price: 699, currency: "USD", gear_type: "Tent" });
    duplexId = results[0]!.item!.id as number;

    // same brand + name, any case: the vault already holds it, and says so
    const again = await call("add_my_gear", { items: [{ name: "duplex", brand: "ZPACKS", folder: "shelter" }] }, writeToken);
    expect((again.data.results as { status: string }[])[0]!.status).toBe("already_have");
    // "shelter" matched the existing folder rather than making a second
    const folders = await db.select().from(schema.vaultFolders);
    expect(folders.map((f) => f.name).sort()).toEqual(["Shelter", "Sleep"]);
  });

  it("lists, searches and filters by folder", async () => {
    const all = await call("list_my_gear", {}, readToken);
    expect(all.data.total).toBe(2);
    expect(all.data.folders).toEqual(["Shelter", "Sleep"]);
    const found = await call("list_my_gear", { query: "revelation" }, readToken);
    expect((found.data.gear as { name: string }[]).map((g) => g.name)).toEqual(["Revelation"]);
    const sleep = await call("list_my_gear", { folder: "SLEEP" }, readToken);
    expect((sleep.data.gear as { name: string }[]).map((g) => g.name)).toEqual(["Revelation"]);
    const none = await call("list_my_gear", { folder: "Kitchen" }, readToken);
    expect(none.isError).toBe(true);
    expect(none.text).toContain("Shelter, Sleep");
    const page = await call("list_my_gear", { limit: 1, offset: 1 }, readToken);
    expect(page.data).toMatchObject({ total: 2, offset: 1 });
    expect(page.data.gear).toHaveLength(1);
  });

  it("changes a field, clears another, and moves it to a new folder", async () => {
    const r = await call("update_my_gear", { id: duplexId, weight_g: 545, price: null, folder: "Big three" }, writeToken);
    expect(r.isError, r.text).toBe(false);
    expect(r.data.item).toMatchObject({ id: duplexId, weight_g: 545, price: null, currency: null, folder: "Big three" });
    const unfiled = await call("update_my_gear", { id: duplexId, folder: "" }, writeToken);
    expect(unfiled.data.item).toMatchObject({ folder: null });
    expect((await call("update_my_gear", { id: duplexId, name: null }, writeToken)).isError).toBe(true);
    expect((await call("update_my_gear", { id: duplexId }, writeToken)).isError).toBe(true);
  });

  it("reaches no other account's gear", async () => {
    const theirs = await call("add_my_gear", { items: [{ name: "Their stove" }] }, strangerToken);
    const theirId = (theirs.data.results as { item: { id: number } }[])[0]!.item.id;
    expect((await call("update_my_gear", { id: theirId, weight_g: 1 }, writeToken)).isError).toBe(true);
    expect((await call("remove_my_gear", { id: theirId }, writeToken)).isError).toBe(true);
    const mine = await call("list_my_gear", {}, writeToken);
    expect((mine.data.gear as { name: string }[]).map((g) => g.name)).not.toContain("Their stove");
    // and a made-up folder name on a bad id leaves no folder behind
    await call("update_my_gear", { id: theirId, folder: "Nope" }, writeToken);
    expect((await db.select().from(schema.vaultFolders)).map((f) => f.name)).not.toContain("Nope");
  });

  it("puts gear away and brings it back", async () => {
    const gone = await call("remove_my_gear", { id: duplexId }, writeToken);
    expect(gone.data).toEqual({ id: duplexId, status: "removed" });
    expect((await call("list_my_gear", {}, readToken)).data.total).toBe(1);
    expect((await call("remove_my_gear", { id: duplexId }, writeToken)).isError).toBe(true);
    const back = await call("remove_my_gear", { id: duplexId, restore: true }, writeToken);
    expect(back.data).toEqual({ id: duplexId, status: "restored" });
    expect((await call("list_my_gear", {}, readToken)).data.total).toBe(2);
  });

  it("loses its reach once revoked, by hand or by account deletion", async () => {
    expect(await revokeAllAccessTokens(db, me)).toBe(2);
    expect((await call("list_my_gear", {}, writeToken)).isError).toBe(true);
    await deleteAccount(db, stranger, { deleteLists: false });
    expect(await db.select().from(schema.accessTokens)).toHaveLength(0);
    expect((await call("list_my_gear", {}, strangerToken)).isError).toBe(true);
  });
});
