// The account tables as an OLDER database meets them: built by an earlier build, then
// brought forward by the idempotent ALTERs. Both roads have to end at the same table.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { createTestDb } from "./helpers/db";

describe("access_tokens.kind on a table made before the column existed", () => {
  const BEFORE_KIND = [
    `CREATE TABLE IF NOT EXISTS access_tokens (
      id serial PRIMARY KEY,
      token_hash text NOT NULL,
      user_id integer NOT NULL,
      label text,
      scope text NOT NULL CHECK (scope IN ('read', 'write')),
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz
    )`,
  ];
  const insert = (kind: string) => sql`INSERT INTO access_tokens (token_hash, user_id, kind, scope) VALUES (${"h-" + kind}, 1, ${kind}, 'read')`;

  it("holds the same vocabulary the fresh table does", async () => {
    const db = await createTestDb(BEFORE_KIND, ACCOUNT_DDL);
    await db.execute(insert("token"));
    await db.execute(insert("app"));
    await expect(db.execute(insert("bogus"))).rejects.toThrow();
  });

  it("is refused the same way on a fresh table", async () => {
    const db = await createTestDb(ACCOUNT_DDL);
    await expect(db.execute(insert("bogus"))).rejects.toThrow();
  });
});
