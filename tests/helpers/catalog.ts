// A catalog row, seeded and read back. catalog.test.ts wrote the insert eleven times
// and the weight read-back seven; candidates, seedRenames, seedSizes and
// hydrateCatalogNames each had their own copies of the insert.

import { eq } from "drizzle-orm";
import * as schema from "../../server/db/schema";
import type { TestDb } from "./db";

/** Insert one catalog row — an unverified community stake unless `over` says
 *  otherwise — and return it. */
export async function seedCatalogRow(db: TestDb, over: Partial<typeof schema.catalogItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.catalogItems)
    .values({ name: "Generic stake", weightMg: 12_000, weightSource: "community", verified: false, ...over })
    .returning();
  return row!;
}

/** The row, as stored now. */
export async function catalogRow(db: TestDb, id: number) {
  const [row] = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, id));
  return row!;
}

/** The row's weight, as stored now — bigint comes back as a string from one driver
 *  and a number from the other, so it is read through Number() here, once. */
export const weightOf = async (db: TestDb, id: number): Promise<number> => Number((await catalogRow(db, id)).weightMg);
