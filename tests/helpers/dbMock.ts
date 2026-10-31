// Point the server's own connection accessors at a suite's throwaway database.
//
// Endpoints and the session/edit gates reach for useAccountDb()/useVaultDb()/
// useDb()/useCatalogDb() themselves rather than taking a handle, so a suite that
// drives them has to swap the module. The one-liner each suite keeps is
//
//   vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));
//
// vi.mock factories are hoisted above the file's imports, which is why the helper is
// pulled in with a dynamic import INSIDE the factory rather than a static one at the
// top: the static binding would not exist yet when the factory runs. The state is
// module-level, so the suite's own import of `dbState` and the factory's import see
// the same object.

import type { TestDb } from "./db";

export const dbState = {
  /** what every accessor resolves to — set it in beforeEach, after createTestDb */
  db: undefined as TestDb | undefined,
  /** when true every accessor throws — a case proving a path never touches the
   *  database (editAuthGate's bearer path) flips it on */
  throwIfTouched: false,
};

export async function mockDbModule(
  importOriginal: <T = Record<string, unknown>>() => Promise<T>,
): Promise<Record<string, unknown>> {
  const mod = await importOriginal<typeof import("../../server/utils/db")>();
  const grab = async () => {
    if (dbState.throwIfTouched) throw new Error("this path must not touch the database");
    return dbState.db;
  };
  return { ...mod, useDb: grab, useCatalogDb: grab, useVaultDb: grab, useAccountDb: grab };
}
