import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { lists, type ListRow } from "../server/db/schema";
import { LISTS_DDL, SNAPSHOTS_DDL } from "../server/utils/db";
import {
  applyOpsByEditToken,
  listSnapshotsByEditToken,
  restoreSnapshotByEditToken,
  rowToSnapshot,
} from "../server/utils/listRepo";
import { sha256Hex } from "../server/utils/tokens";
import { summarizeOps } from "../shared/changeSummary";
import { cloneListData } from "../shared/clone";
import { csvToListData, listToCsv } from "../shared/exporters/csv";
import { jsonToListImport, listToJson } from "../shared/exporters/json";
import { listToMarkdown } from "../shared/exporters/markdown";
import { applyOps, MAX_PEOPLE, normalizePerson, tidyListText, type Op } from "../shared/ops";
import {
  effectivePersonId,
  filterItemsForPerson,
  hasUnassignedTopLevel,
  personSlot,
  sortedPeople,
  UNASSIGNED,
  visibleItemsForPerson,
} from "../shared/people";
import {
  applyListDiff,
  diffListState,
  fullSnapToState,
  stateToFullSnap,
} from "../shared/snapshotDiff";
import type { Item, ListData, ListSnapshot, ListState, Person } from "../shared/types";
import { captureFromList } from "../shared/vault";
import { computeTotals } from "../shared/weights";
import { createTestDb, makeList } from "./helpers/db";

const state = (over: Partial<ListState> = {}): ListState => ({
  title: "Trip",
  displayUnit: "g",
  folders: [],
  items: [],
  people: [],
  version: 1,
  ...over,
});

const person = (over: Partial<Person> = {}): Person => ({
  id: "p1",
  name: "Ryan",
  colorKey: "shelter",
  sortOrder: 0,
  ...over,
});

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  folderId: null,
  name: "Bear Can",
  unitWeightMg: 1000,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

const ryan = () => person({ id: "ryan", name: "Ryan", sortOrder: 0 });
const matt = () => person({ id: "matt", name: "Matt", colorKey: "sleep", sortOrder: 1 });

describe("person ops", () => {
  it("adds, updates and removes", () => {
    const s = state();
    applyOps(s, [{ t: "addPerson", person: ryan() }]);
    expect(s.people).toHaveLength(1);
    expect(s.people![0]).toMatchObject({ id: "ryan", name: "Ryan" });

    applyOps(s, [{ t: "updatePerson", id: "ryan", patch: { name: "Ryan K", colorKey: "water" } }]);
    expect(s.people![0]).toMatchObject({ name: "Ryan K", colorKey: "water" });

    applyOps(s, [{ t: "removePerson", id: "ryan" }]);
    expect(s.people).toHaveLength(0);
  });

  it("refuses a duplicate id, like addFolder does", () => {
    const s = state();
    applyOps(s, [
      { t: "addPerson", person: ryan() },
      { t: "addPerson", person: person({ id: "ryan", name: "Impostor" }) },
    ]);
    expect(s.people).toHaveLength(1);
    expect(s.people![0]!.name).toBe("Ryan");
  });

  it("caps the crew at MAX_PEOPLE", () => {
    const s = state();
    const ops: Op[] = Array.from({ length: MAX_PEOPLE + 5 }, (_, i) => ({
      t: "addPerson",
      person: person({ id: `p${i}`, name: `P${i}`, sortOrder: i }),
    }));
    applyOps(s, ops);
    expect(s.people).toHaveLength(MAX_PEOPLE);
  });

  it("ignores an op for a person that isn't there, rather than throwing", () => {
    const s = state();
    applyOps(s, [
      { t: "updatePerson", id: "nope", patch: { name: "X" } },
      { t: "removePerson", id: "nope" },
    ]);
    expect(s.people).toHaveLength(0);
  });

  it("works on a state that predates people entirely", () => {
    // the shape every existing row has: no `people` key at all
    const s = { title: "T", displayUnit: "g", folders: [], items: [], version: 1 } as unknown as ListState;
    applyOps(s, [{ t: "addPerson", person: ryan() }]);
    expect(s.people).toHaveLength(1);
  });

  it("removing a person keeps their items, unassigned — nested ones included", () => {
    const s = state({
      people: [ryan(), matt()],
      items: [
        item({ id: "a", personId: "ryan" }),
        item({ id: "b", name: "Cook Kit", personId: "matt", sortOrder: 1 }),
        item({ id: "c", name: "Pot", parentId: "b", personId: "matt", sortOrder: 0 }),
      ],
    });
    applyOps(s, [{ t: "removePerson", id: "matt" }]);
    expect(s.items).toHaveLength(3); // the gear survives
    expect(s.items.find((i) => i.id === "b")!.personId).toBeUndefined();
    expect(s.items.find((i) => i.id === "c")!.personId).toBeUndefined();
    expect(s.items.find((i) => i.id === "a")!.personId).toBe("ryan"); // untouched
  });
});

describe("normalizePerson + patches", () => {
  it("clamps the name and never leaves a person nameless", () => {
    expect(normalizePerson(person({ name: "x".repeat(80) })).name).toHaveLength(60);
    expect(normalizePerson(person({ name: "   " })).name).toBe("Person");
  });

  it("rejects a hostile colorKey — it is interpolated into CSS", () => {
    expect(normalizePerson(person({ colorKey: "x,url(//evil)" })).colorKey).toBe("other");
    expect(normalizePerson(person({ colorKey: "sleep" })).colorKey).toBe("sleep");
  });

  it("a rename to nothing is ignored, not stored", () => {
    const s = state({ people: [ryan()] });
    applyOps(s, [{ t: "updatePerson", id: "ryan", patch: { name: "   " } }]);
    expect(s.people![0]!.name).toBe("Ryan");
  });

  it("a hostile colorKey patch is dropped", () => {
    const s = state({ people: [ryan()] });
    applyOps(s, [{ t: "updatePerson", id: "ryan", patch: { colorKey: "u r l(x)" } }]);
    expect(s.people![0]!.colorKey).toBe("shelter");
  });
});

describe("personId on items", () => {
  it("assigns and clears through updateItem (null = the wire's clear)", () => {
    const s = state({ people: [ryan()], items: [item()] });
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { personId: "ryan" } }]);
    expect(s.items[0]!.personId).toBe("ryan");
    applyOps(s, [{ t: "updateItem", id: "i1", patch: { personId: null } }]);
    expect(s.items[0]!.personId).toBeUndefined();
  });

  it("heals a dangling assignee on updateItem — both sides converge after a race", () => {
    const s = state({ people: [ryan()], items: [item()] });
    // a removePerson and an in-flight assignment can land in either order; the
    // reducer runs on both client and server, so both end unassigned
    applyOps(s, [
      { t: "removePerson", id: "ryan" },
      { t: "updateItem", id: "i1", patch: { personId: "ryan" } },
    ]);
    expect(s.items[0]!.personId).toBeUndefined();
  });

  it("heals a dangling assignee on addItem, like a dangling folderId", () => {
    const s = state({ people: [ryan()] });
    applyOps(s, [
      { t: "addItem", item: item({ id: "ok", personId: "ryan" }) },
      { t: "addItem", item: item({ id: "bad", personId: "ghost", sortOrder: 1 }) },
    ]);
    expect(s.items.find((i) => i.id === "ok")!.personId).toBe("ryan");
    expect(s.items.find((i) => i.id === "bad")!.personId).toBeUndefined();
  });
});

describe("filtering + per-person totals", () => {
  const crew = () => [ryan(), matt()];
  // Ryan's can (1 kg), Matt's kit (500 g) with an inheriting pot (300 g) and
  // Ryan's own spoon (50 g) nested inside Matt's kit, plus an unclaimed tarp.
  const gear = (): Item[] => [
    item({ id: "can", personId: "ryan" }),
    item({ id: "kit", name: "Cook Kit", personId: "matt", unitWeightMg: 500, sortOrder: 1 }),
    item({ id: "pot", name: "Pot", parentId: "kit", unitWeightMg: 300, sortOrder: 0 }),
    item({ id: "spoon", name: "Spoon", parentId: "kit", personId: "ryan", unitWeightMg: 50, sortOrder: 1 }),
    item({ id: "tarp", name: "Tarp", unitWeightMg: 700, sortOrder: 2 }),
  ];

  it("effectivePersonId: own claim, else the parent's", () => {
    const kit = item({ id: "kit", personId: "matt" });
    expect(effectivePersonId(item({ id: "pot" }), kit)).toBe("matt");
    expect(effectivePersonId(item({ id: "spoon", personId: "ryan" }), kit)).toBe("ryan");
    expect(effectivePersonId(item({ id: "tarp" }), null)).toBeUndefined();
  });

  it("filterItemsForPerson is strict — the counted set", () => {
    const items = gear();
    expect(filterItemsForPerson(items, "ryan").map((i) => i.id)).toEqual(["can", "spoon"]);
    expect(filterItemsForPerson(items, "matt").map((i) => i.id)).toEqual(["kit", "pot"]);
    expect(filterItemsForPerson(items, UNASSIGNED).map((i) => i.id)).toEqual(["tarp"]);
    expect(filterItemsForPerson(items, null)).toBe(items); // everyone = the list itself
  });

  it("visibleItemsForPerson keeps a parent as context around a matching child", () => {
    const items = gear();
    // Ryan's spoon lives in Matt's kit — the kit stays visible so the spoon has a home
    expect(visibleItemsForPerson(items, "ryan").map((i) => i.id)).toEqual(["can", "kit", "spoon"]);
    // …but Matt's view never needed the favor: his kit is his
    expect(visibleItemsForPerson(items, "matt").map((i) => i.id)).toEqual(["kit", "pot"]);
  });

  it("per-person totals are the strict set through the ordinary computeTotals", () => {
    const items = gear();
    const forRyan = computeTotals({ folders: [], items: filterItemsForPerson(items, "ryan") });
    expect(forRyan.totalMg).toBe(1050); // can + spoon, never the kit he only visits
    const forMatt = computeTotals({ folders: [], items: filterItemsForPerson(items, "matt") });
    expect(forMatt.totalMg).toBe(800); // kit + inheriting pot
  });

  it("hasUnassignedTopLevel reads top-level rows only — children follow their parent", () => {
    expect(hasUnassignedTopLevel(gear())).toBe(true); // the tarp
    expect(hasUnassignedTopLevel(gear().filter((i) => i.id !== "tarp"))).toBe(false);
  });

  it("personSlot is the display-order index the CSS filter matches on", () => {
    const people = [matt(), ryan()]; // array order ≠ sortOrder
    expect(sortedPeople(people).map((p) => p.id)).toEqual(["ryan", "matt"]);
    expect(personSlot(people, "ryan")).toBe(0);
    expect(personSlot(people, "matt")).toBe(1);
    expect(personSlot(people, "ghost")).toBeNull();
    expect(personSlot(people, undefined)).toBeNull();
  });
});

describe("round-trips", () => {
  const full = () =>
    state({
      people: [ryan(), matt()],
      items: [item({ id: "can", personId: "ryan" }), item({ id: "tarp", name: "Tarp", sortOrder: 1 })],
    });

  it("survives the full-snapshot round trip", () => {
    const back = fullSnapToState(stateToFullSnap(full()));
    expect(back.people).toHaveLength(2);
    expect(back.items.find((i) => i.id === "can")!.personId).toBe("ryan");
  });

  it("diffs and re-applies people like every other entity", () => {
    const base = full();
    const target = full();
    // rename ryan, drop matt, add a third
    target.people = [
      { ...ryan(), name: "Ryan K" },
      person({ id: "sam", name: "Sam", sortOrder: 2 }),
    ];
    const diff = diffListState(base, target);
    expect(diff.peopleUpsert?.map((p) => p.id).sort()).toEqual(["ryan", "sam"]);
    expect(diff.peopleDel).toEqual(["matt"]);
    const rebuilt = applyListDiff(base, diff);
    expect(sortedPeople(rebuilt.people).map((p) => p.name)).toEqual(["Ryan K", "Sam"]);
  });

  it("a snapshot diff on states that predate people doesn't invent the key", () => {
    const old = { title: "T", displayUnit: "g", folders: [], items: [], version: 1 } as unknown as ListState;
    const diff = diffListState(old, old);
    expect(diff.peopleUpsert).toBeUndefined();
    expect(diff.peopleDel).toBeUndefined();
  });

  it("cloneListData keeps the crew with fresh ids and re-pointed assignments", () => {
    const src = full();
    const copy = cloneListData(src);
    expect(copy.people).toHaveLength(2);
    // every id re-minted…
    for (const p of copy.people) expect(["ryan", "matt"]).not.toContain(p.id);
    // …and the assignment follows the same person by name
    const can = copy.items[0]!;
    const carrier = copy.people.find((p) => p.id === can.personId);
    expect(carrier?.name).toBe("Ryan");
    // a dangling source assignment degrades to unassigned
    const wonky = cloneListData({ ...src, items: [item({ personId: "ghost" })] });
    expect(wonky.items[0]!.personId).toBeUndefined();
  });

  it("JSON backup round-trips people and re-points personId through fresh ids", () => {
    const src = full();
    const json = listToJson(src);
    const back = jsonToListImport(json)!;
    expect(back.data.people).toHaveLength(2);
    const can = back.data.items.find((i) => i.name === "Bear Can")!;
    const carrier = back.data.people!.find((p) => p.id === can.personId);
    expect(carrier?.name).toBe("Ryan");
    // ids re-minted, so the file's ids never survive into the new list
    for (const p of back.data.people!) expect(["ryan", "matt"]).not.toContain(p.id);
  });

  it("a backup written before people existed imports with an empty crew", () => {
    const legacy = JSON.stringify({ title: "Old", folders: [], items: [] });
    expect(jsonToListImport(legacy)!.data.people).toEqual([]);
  });

  it("CSV appends a Person column with the EFFECTIVE carrier and reads it back", () => {
    const snap = {
      ...full(),
      items: [
        item({ id: "kit", name: "Cook Kit", personId: "matt" }),
        item({ id: "pot", name: "Pot", parentId: "kit", sortOrder: 1 }),
        item({ id: "tarp", name: "Tarp", sortOrder: 2 }),
      ],
    } as unknown as ListSnapshot;
    const csv = listToCsv(snap);
    expect(csv.split("\n")[0]).toMatch(/,Kcal,Person$/);
    const potLine = csv.split("\n").find((l) => l.includes("Pot"))!;
    expect(potLine.endsWith(",Matt")).toBe(true); // the child flattens, so its inherited carrier is written out

    const back = csvToListData(csv);
    expect(back.people?.map((p) => p.name).sort()).toEqual(["Matt"]);
    const backPot = back.items.find((i) => i.name === "Pot")!;
    expect(back.people!.find((p) => p.id === backPot.personId)?.name).toBe("Matt");
    const backTarp = back.items.find((i) => i.name === "Tarp")!;
    expect(backTarp.personId).toBeUndefined();
  });

  it("a CSV with no Person column (LighterPack) imports peopleless, key and all", () => {
    const back = csvToListData("Item Name,Weight,Unit\nTent,900,g\n");
    expect("people" in back).toBe(false);
  });

  it("markdown names the carrier, and a child only when it differs from the group's", () => {
    const snap = {
      ...full(),
      items: [
        item({ id: "kit", name: "Cook Kit", personId: "matt" }),
        item({ id: "pot", name: "Pot", parentId: "kit", sortOrder: 1 }),
        item({ id: "spoon", name: "Spoon", parentId: "kit", personId: "ryan", sortOrder: 2 }),
      ],
    } as unknown as ListSnapshot;
    const md = listToMarkdown(snap);
    expect(md).toContain("Cook Kit *(Matt)*");
    expect(md).not.toContain("Pot *(Matt)*"); // inherits silently
    expect(md).toContain("Spoon *(Ryan)*"); // the exception is worth naming
  });

  it("tidyListText tidies person names like folder names", () => {
    const s = state({ people: [person({ name: "Ryan's  brother" })] });
    tidyListText(s);
    expect(s.people![0]!.name).toBe("Ryan’s brother");
  });

  it("the vault never captures who carries a thing", () => {
    const caps = captureFromList(
      [item({ id: "can", name: "Bear Can", brand: "BearVault", personId: "ryan", weightOverridden: true })],
      [],
    );
    expect(caps).toHaveLength(1);
    expect("personId" in caps[0]!).toBe(false);
  });
});

describe("change summaries", () => {
  const before = { items: [item({ id: "can" })], folders: [], people: [ryan(), matt()] };

  it("names an added person, at the days' structural level", () => {
    expect(summarizeOps([{ t: "addPerson", person: matt() }])).toBe("Added Matt to the trip");
  });

  it("names a removed person from the before state", () => {
    expect(summarizeOps([{ t: "removePerson", id: "matt" }], before)).toBe("Removed Matt from the trip");
  });

  it("says who an item went to", () => {
    expect(
      summarizeOps([{ t: "updateItem", id: "can", patch: { personId: "matt" } }], before),
    ).toBe("Reassigned Bear Can to Matt");
    expect(
      summarizeOps([{ t: "updateItem", id: "can", patch: { personId: null } }], before),
    ).toBe("Reassigned Bear Can");
  });
});

describe("read paths", () => {
  const row = (data: Partial<ListData>) =>
    ({
      id: 1,
      publicSlug: "trip-a1b2c3",
      editTokenHash: "hash",
      shareCode: "ABC123",
      title: "Trip",
      description: null,
      displayUnit: "g",
      startDate: null,
      endDate: null,
      data: { folders: [], items: [], days: [], waypoints: [], ...data },
      isPublic: false,
      version: 1,
      updatedAt: new Date("2026-08-06T00:00:00Z"),
    }) as unknown as ListRow;

  it("people + assignments ride every read path — they are list content, like days", () => {
    const snap = rowToSnapshot(
      row({ people: [ryan()], items: [item({ id: "can", personId: "ryan", packed: true })] }),
    );
    expect(snap.people).toHaveLength(1);
    expect(snap.people![0]!.name).toBe("Ryan");
    expect(snap.items[0]!.personId).toBe("ryan");
    // …while the tick beside them is still the owner's own business
    expect("packed" in snap.items[0]!).toBe(false);
  });

  it("a row written before people existed reads back with an empty crew", () => {
    const snap = rowToSnapshot(row({}));
    expect(snap.people).toEqual([]);
  });
});

describe("persistence — the silent-erasure regression", () => {
  async function freshDb() {
    return createTestDb(LISTS_DDL, SNAPSHOTS_DDL);
  }
  const readData = async (db: Awaited<ReturnType<typeof freshDb>>, editToken: string) => {
    const [r] = await db.select().from(lists).where(eq(lists.editTokenHash, sha256Hex(editToken)));
    return r!.data as ListData;
  };

  it("people survive an edit that has nothing to do with them", async () => {
    // the exact shape the waypoints bug had: the reducer holds the entity, the
    // write path's data literal forgets the key, and the next keystroke erases it
    const db = await freshDb();
    const { editToken } = await makeList(db, "Crew trip", {
      data: { folders: [], items: [item({ id: "can" })] },
    });
    await applyOpsByEditToken(
      editToken,
      [
        { t: "addPerson", person: ryan() },
        { t: "updateItem", id: "can", patch: { personId: "ryan" } },
      ],
      db,
    );
    // the unrelated keystroke batch
    await applyOpsByEditToken(editToken, [{ t: "updateItem", id: "can", patch: { name: "Bear Can 2" } }], db);
    const data = await readData(db, editToken);
    expect(data.people).toHaveLength(1);
    expect(data.items[0]!.personId).toBe("ryan");
  });

  it("a snapshot restore brings the crew back", async () => {
    const db = await freshDb();
    const { editToken } = await makeList(db, "Crew trip", {
      data: {
        folders: [],
        items: [item({ id: "can", personId: "ryan" })],
        people: [ryan()],
      },
    });
    // wreck it: the mutate snapshots the pre-edit state (people included) first
    await applyOpsByEditToken(editToken, [{ t: "removePerson", id: "ryan" }], db);
    expect((await readData(db, editToken)).people).toHaveLength(0);
    const snaps = await listSnapshotsByEditToken(editToken, db);
    expect(snaps!.length).toBeGreaterThan(0);
    const restored = await restoreSnapshotByEditToken(editToken, snaps![0]!.id, db);
    expect(restored!.people).toHaveLength(1);
    expect(restored!.people![0]!.name).toBe("Ryan");
    expect(restored!.items[0]!.personId).toBe("ryan");
  });
});
