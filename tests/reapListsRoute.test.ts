// The nightly maintenance ROUTE (server/routes/api/cron/reap-lists.ts), driven as the
// cron hits it: a real H3 event with the cron secret, no server booted. The sweeps
// themselves have their own suites (reapLists.test.ts, trailFavicon.test.ts); what
// lives only at this layer is that the route runs each stage and reports its count.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lists } from "../server/db/schema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { LISTS_DDL, SNAPSHOTS_DDL } from "../server/utils/db";
import { refreshStaleFavicons } from "../server/utils/trailFavicon";
import reapListsRoute from "../server/routes/api/cron/reap-lists";
import { createTestDb, makeList, type TestDb } from "./helpers/db";
import { makeEvent } from "./helpers/http";

// The route reaches for the connection accessors itself; each answers this file's
// throwaway database.
const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../server/utils/db", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../server/utils/db")>();
  const grab = async () => state.db;
  return {
    ...mod,
    useDb: grab,
    useAccountDb: grab,
    useCatalogDb: grab,
  };
});

// The favicon stage fetches third-party hosts; here it only has to be seen to run.
vi.mock("../server/utils/trailFavicon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/utils/trailFavicon")>()),
  refreshStaleFavicons: vi.fn(async () => ({ checked: 2, updated: 1 })),
}));

// requireCron throttles through Nitro's `useStorage("kv")`, which plain vitest lacks.
const kv = new Map<string, unknown>();
vi.stubGlobal("useStorage", () => ({
  getItem: async (key: string) => kv.get(key) ?? null,
  setItem: async (key: string, value: unknown) => void kv.set(key, value),
  removeItem: async (key: string) => void kv.delete(key),
}));

const SECRET = "cron-secret-for-tests";
const run = () => reapListsRoute(makeEvent("/api/cron/reap-lists", { headers: { authorization: `Bearer ${SECRET}` } }));

const DAY = 86_400_000;

describe("the nightly maintenance route", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL, ACCOUNT_DDL);
    state.db = db;
    kv.clear();
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.mocked(refreshStaleFavicons).mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // one abandoned empty list, past the reap's window
    await makeList(db, "Abandoned", { updatedAt: new Date(Date.now() - 40 * DAY) });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("runs every stage and answers with each one's count", async () => {
    expect(await run()).toEqual({
      ok: true,
      reaped: 1,
      purged: 0,
      favicons: { checked: 2, updated: 1 },
    });
    expect((await db.select().from(lists))[0]!.deletedAt).toBeInstanceOf(Date);
  });
});
