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
import { dbState } from "./helpers/dbMock";
import { makeEvent } from "./helpers/http";
import { memoryKv } from "./helpers/kv";

// The route reaches for the connection itself; it answers this file's throwaway database.
vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));

// The favicon stage fetches third-party hosts; here it only has to be seen to run.
vi.mock("../server/utils/trailFavicon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/utils/trailFavicon")>()),
  refreshStaleFavicons: vi.fn(async () => ({ checked: 2, updated: 1 })),
}));

// requireCron throttles through Nitro's `useStorage("kv")`, which plain vitest lacks.
const kv = memoryKv();
vi.stubGlobal("useStorage", () => kv);

const SECRET = "cron-secret-for-tests";
const run = () => reapListsRoute(makeEvent("/api/cron/reap-lists", { headers: { authorization: `Bearer ${SECRET}` } }));

const DAY = 86_400_000;

describe("the nightly maintenance route", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb(LISTS_DDL, SNAPSHOTS_DDL, ACCOUNT_DDL);
    dbState.db = db;
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

  // The favicon stage calls third-party hosts, so it is the one stage walled off: the
  // reap and the purge before it stand, and are reported, whatever it does.
  it("loses only the favicon stage when the refresh fails", async () => {
    vi.mocked(refreshStaleFavicons).mockRejectedValueOnce(new Error("host timed out"));

    expect(await run()).toEqual({ ok: true, reaped: 1, purged: 0, favicons: { checked: 0, updated: 0 } });
    expect(console.warn).toHaveBeenCalledWith("[cron] favicon refresh failed", "host timed out");
  });
});
