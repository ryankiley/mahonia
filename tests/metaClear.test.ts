import { describe, expect, it } from "vitest";
import { LISTS_DDL } from "../server/utils/db";
import { applyOpsByEditHash, findByEditHash } from "../server/utils/listRepo";
import { sha256Hex } from "../server/utils/tokens";
import { createTestDb, makeList } from "./helpers/db";

// A meta CLEAR has to reach the ROW. The reducer clears a field by deleting its key
// (shared/ops setOrClear), and the mutate write once walked the thirteen columns by
// hand as `state.x ?? null`; a rewrite that copied only the keys it found left every
// cleared column holding its old value — version bumped, pins reseeded, trail still
// there. The reducer and the op builder were both tested; the persisted row was not.
describe("applyOpsByEditHash persists a meta clear", () => {
  it("writes null for every field the patch cleared, and echoes the same", async () => {
    const db = await createTestDb(LISTS_DDL);
    const { editToken } = await makeList(db, "Trail list", {
      trailUrl: "https://www.alltrails.com/trail/us/oregon/timberline-trail",
      trailLabel: "Timberline Trail",
      trailDistanceM: 65_000,
      trailDistanceUnit: "mi",
      startDate: "2026-08-01",
      endDate: "2026-08-04",
      routeGeometry: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
      data: { folders: [], items: [], waypoints: [{ id: "w1", kind: "water", distanceM: 1000 }] },
    } as never);
    const hash = sha256Hex(editToken);
    expect((await findByEditHash(hash, db))?.trailLabel).toBe("Timberline Trail");

    // the "remove the trail" patch the client and the connector send
    const echoed = await applyOpsByEditHash(
      hash,
      [
        {
          t: "setMeta",
          patch: {
            trailUrl: "",
            trailLabel: "",
            trailDistanceM: "",
            trailDistanceUnit: "",
            trailProfile: "",
            trailAscentM: "",
            trailDescentM: "",
            routeGeometry: "",
            startDate: "",
            endDate: "",
          },
        },
      ],
      db,
    );
    const row = await findByEditHash(hash, db);
    for (const snap of [echoed, row]) {
      expect(snap?.trailUrl ?? null).toBeNull();
      expect(snap?.trailLabel ?? null).toBeNull();
      expect(snap?.trailDistanceM ?? null).toBeNull();
      expect(snap?.trailDistanceUnit ?? null).toBeNull();
      expect(snap?.startDate ?? null).toBeNull();
      expect(snap?.endDate ?? null).toBeNull();
      expect(snap?.routeGeometry ?? null).toBeNull();
    }
    expect(row?.version).toBe(2);
  });
});
