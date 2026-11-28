import { beforeEach, describe, expect, it, vi } from "vitest";
import { LISTS_DDL } from "../server/utils/db";
import { createList } from "../server/utils/listRepo";
import type { ListData } from "../shared/types";
import { createTestDb } from "./helpers/db";
import { dbState } from "./helpers/dbMock";

vi.mock("../server/utils/db", async (o) => (await import("./helpers/dbMock")).mockDbModule(o));

// The create route checks only that folders and items are arrays; what is IN them is
// whatever the request body said.
describe("createList with rows that are not objects", () => {
  beforeEach(async () => {
    dbState.db = await createTestDb(LISTS_DDL);
  });

  it("drops them and keeps the rows beside them", async () => {
    const junk = [null, "tent", 7, ["nested"]];
    const { snapshot } = await createList({
      title: "Trip",
      data: {
        folders: [...junk, { id: "f1", name: "Shelter" }],
        items: [...junk, { id: "i1", name: "Tent", folderId: "f1", qty: 1 }],
        days: junk,
        waypoints: junk,
        people: junk,
      } as unknown as ListData,
    });
    expect(snapshot.folders.map((f) => f.id)).toEqual(["f1"]);
    expect(snapshot.items.map((i) => i.id)).toEqual(["i1"]);
    expect(snapshot.days).toEqual([]);
    expect(snapshot.waypoints).toEqual([]);
    expect(snapshot.people).toEqual([]);
  });

  // days, waypoints and people are not checked at all, so a body can send anything there
  it("reads days, waypoints or people that are not arrays as none", async () => {
    const { snapshot } = await createList({
      title: "Trip",
      data: {
        folders: [{ id: "f1", name: "Shelter" }],
        items: [{ id: "i1", name: "Tent", folderId: "f1", qty: 1 }],
        days: 5,
        waypoints: { id: "w1" },
        people: "Ryan",
      } as unknown as ListData,
    });
    expect(snapshot.items.map((i) => i.id)).toEqual(["i1"]);
    expect(snapshot.days).toEqual([]);
    expect(snapshot.waypoints).toEqual([]);
    expect(snapshot.people).toEqual([]);
  });
});
