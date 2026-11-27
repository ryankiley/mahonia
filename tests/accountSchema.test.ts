// The account tables keep their closed vocabularies themselves: a CHECK refuses a
// value the code would never write, whichever caller tries.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { createTestDb } from "./helpers/db";

describe("access_tokens.kind", () => {
  const insert = (kind: string) => sql`INSERT INTO access_tokens (token_hash, user_id, kind, scope) VALUES (${"h-" + kind}, 1, ${kind}, 'read')`;

  it("takes a token and an app, and refuses anything else", async () => {
    const db = await createTestDb(ACCOUNT_DDL);
    await db.execute(insert("token"));
    await db.execute(insert("app"));
    await expect(db.execute(insert("bogus"))).rejects.toThrow();
  });
});
