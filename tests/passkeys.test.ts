import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import {
  deletePasskey,
  existingCredentialIds,
  findCredential,
  listPasskeys,
  savePasskey,
  touchCredential,
} from "../server/utils/credentialRepo";
import { findOrCreateUser } from "../server/utils/authSession";
import { createTestDb } from "./helpers/db";

type DB = ReturnType<typeof drizzle>;
async function freshDb(): Promise<DB> {
  return createTestDb(ACCOUNT_DDL);
}

const key = (over: Record<string, unknown> = {}) => ({
  userId: 1,
  credentialId: "cred-abc",
  publicKey: "cHVibGlj",
  counter: 0,
  discoverable: true,
  label: "iPhone",
  ...over,
}) as any;

describe("passkey storage", () => {
  let db: DB;
  beforeEach(async () => {
    db = await freshDb();
    await findOrCreateUser(db as any, "a@example.com");
    await findOrCreateUser(db as any, "b@example.com");
  });

  it("stores a key and lists it back with its metadata", async () => {
    await savePasskey(db as any, key());
    const listed = await listPasskeys(db as any, 1);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.label).toBe("iPhone");
    expect(listed[0]!.lastUsedAt).toBeNull();
  });

  it("never exposes the public key in the listing — there's nothing to show", async () => {
    await savePasskey(db as any, key());
    expect(JSON.stringify(await listPasskeys(db as any, 1))).not.toContain("cHVibGlj");
  });

  it("refuses to register the same credential twice", async () => {
    await savePasskey(db as any, key());
    await expect(savePasskey(db as any, key())).rejects.toThrow();
    expect(await existingCredentialIds(db as any, 1)).toHaveLength(1);
  });

  it("finds a credential WITHOUT being told the user — that's what makes usernameless sign-in work", async () => {
    await savePasskey(db as any, key({ userId: 2, credentialId: "cred-xyz" }));
    const found = await findCredential(db as any, "cred-xyz");
    expect(found?.userId).toBe(2);
  });

  it("returns null for an unknown credential rather than throwing", async () => {
    expect(await findCredential(db as any, "nope")).toBeNull();
  });

  it("bumps the signature counter and stamps last-used", async () => {
    await savePasskey(db as any, key());
    const cred = await findCredential(db as any, "cred-abc");
    await touchCredential(db as any, cred!.id, 42);
    const after = await findCredential(db as any, "cred-abc");
    expect(Number(after!.counter)).toBe(42);
    expect(after!.lastUsedAt).not.toBeNull();
  });

  it("keeps each account's keys to itself, for listing AND deletion", async () => {
    await savePasskey(db as any, key({ userId: 1, credentialId: "c1" }));
    await savePasskey(db as any, key({ userId: 2, credentialId: "c2" }));
    expect(await listPasskeys(db as any, 1)).toHaveLength(1);
    const mine = (await listPasskeys(db as any, 1))[0]!;
    // user 2 cannot delete user 1's key
    expect(await deletePasskey(db as any, 2, mine.id)).toBe(false);
    expect(await listPasskeys(db as any, 1)).toHaveLength(1);
    expect(await deletePasskey(db as any, 1, mine.id)).toBe(true);
    expect(await listPasskeys(db as any, 1)).toHaveLength(0);
  });

  it("excludes only THIS user's credential ids from re-registration", async () => {
    await savePasskey(db as any, key({ userId: 1, credentialId: "c1" }));
    await savePasskey(db as any, key({ userId: 2, credentialId: "c2" }));
    expect(await existingCredentialIds(db as any, 1)).toEqual(["c1"]);
  });

  it("allows removing the last passkey — the emailed link is always the way back", async () => {
    await savePasskey(db as any, key());
    const only = (await listPasskeys(db as any, 1))[0]!;
    expect(await deletePasskey(db as any, 1, only.id)).toBe(true);
    expect(await existingCredentialIds(db as any, 1)).toHaveLength(0);
  });
});
