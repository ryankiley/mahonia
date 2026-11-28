// The read-only link to My Gear (/g/{code}): what it shows (shared/vaultShare.ts, a pure
// function, so the privacy rules are pinned without a database), and turning it on and
// off and reading it back (server/utils/vaultShare.ts, on PGlite).
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users, vaults } from "../server/db/schema";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { ACCOUNT_DDL } from "../server/utils/accountSchema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { captureVaultItems } from "../server/utils/vaultRepo";
import {
  setVaultShare,
  sharedGearByCode,
  vaultShareCode,
} from "../server/utils/vaultShare";
import { sharedGear, sharedGearSummary, sharedGearTitle } from "../shared/vaultShare";
import { gearCardModel } from "../shared/ogGearCard";
import { cap, vaultRow } from "./helpers/vault";
import { createTestDb, type TestDb } from "./helpers/db";

describe("sharedGear: what the link shows", () => {
  const tent = vaultRow({
    id: 501,
    brand: "Durston",
    name: "X-Mid 2",
    commonName: "Tent",
    icon: "tent",
    owned: 2,
    classification: "worn",
    entryUnit: "oz",
    priceCents: 30_000,
    currency: "USD",
    productUrl: "https://example.test/x-mid",
    catalogItemId: 77,
    pinned: ["weight"],
    kcal: 0,
    inKits: [900],
    specs: "persons=2",
  });
  const bar = vaultRow({
    id: 502,
    name: "Clif Bar",
    commonName: "Energy bar",
    kcal: 250,
    priceCents: 200,
  });
  const kit = vaultRow({
    id: 900,
    name: "Shelter kit",
    kind: "kit",
    ownWeightMg: 20_000,
    weightMg: 579_000,
    parts: [
      { id: 501, qty: 1, brand: "Durston", name: "X-Mid 2", weightMg: 539_000 },
      { id: 502, qty: 2, name: "Clif Bar", weightMg: 68_000 },
    ],
  });

  it("builds each piece from the fields allowed out: no price, link, catalog id, key, pins, counts or dates", () => {
    const { items } = sharedGear([tent, kit], undefined);
    const shown = items.find((i) => i.name === "X-Mid 2")!;
    expect(shown).toEqual({
      id: 1,
      brand: "Durston",
      name: "X-Mid 2",
      commonName: "Tent",
      icon: "tent",
      entryUnit: "oz",
      owned: 2,
      classification: "worn",
      weightMg: 539_000,
      inKits: [2],
      specs: "persons=2",
    });
  });

  it("leaves food off the page, but keeps it as a part where a kit holds it", () => {
    const { items } = sharedGear([tent, bar, kit], undefined);
    expect(items.map((i) => i.name)).toEqual(["X-Mid 2", "Shelter kit"]);
    const k = items.find((i) => i.kind === "kit")!;
    expect(k.parts!.map((p) => [p.name, p.qty])).toEqual([
      ["X-Mid 2", 1],
      ["Clif Bar", 2],
    ]);
  });

  it("renumbers every id and keeps the references between pieces pointing at the same things", () => {
    const { items } = sharedGear([tent, bar, kit], undefined);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual([1, 2]);
    const k = items.find((i) => i.kind === "kit")!;
    // the tent's part is the tent's new number; the bar, off the page, has one of its own
    expect(k.parts![0]!.id).toBe(1);
    expect(k.parts![1]!.id).toBe(3);
    expect(items.find((i) => i.name === "X-Mid 2")!.inKits).toEqual([k.id]);
    // no vault id survives anywhere: every id and reference is one of the new numbers
    const refs = items.flatMap((i) => [
      i.id,
      ...(i.inKits ?? []),
      ...(i.parts ?? []).map((p) => p.id),
    ]);
    expect(refs.every((n) => n >= 1 && n <= 3)).toBe(true);
  });

  // The owner's own page lists a put-away part as "removed" and leaves it out of the
  // kit's weight; a reader's page drew it as one of the kit's items.
  it("leaves out a part the owner has put away", () => {
    const stakes = { id: 503, qty: 6, name: "Old stakes", weightMg: 9_000, removed: true };
    const withStakes = { ...kit, parts: [...kit.parts!, stakes] };
    const k = sharedGear([tent, withStakes], undefined).items.find((i) => i.kind === "kit")!;
    expect(k.parts!.map((p) => p.name)).toEqual(["X-Mid 2", "Clif Bar"]);
  });

  it("names the owner by the name they chose, and otherwise not at all", () => {
    expect(sharedGear([tent], "Ryan").owner).toBe("Ryan");
    expect("owner" in sharedGear([tent], undefined)).toBe(false);
  });
});

describe("the link, on PGlite", () => {
  let db: TestDb;
  let vaultId: number;
  beforeEach(async () => {
    db = await createTestDb(ACCOUNT_DDL, VAULT_DDL, CATALOG_DDL);
    const [u] = await db
      .insert(users)
      .values({ email: "owner@example.test", displayName: "Sam" })
      .returning();
    const [v] = await db.insert(vaults).values({ userId: u!.id }).returning();
    vaultId = v!.id;
    await captureVaultItems(db, vaultId, [
      cap(),
      cap({ name: "Clif Bar", commonName: "Energy bar", kcal: 250 }),
    ]);
  });

  it("is off until turned on, keeps its code when asked twice, and is dead for good once off", async () => {
    expect(await vaultShareCode(db, vaultId)).toBeNull();
    const code = (await setVaultShare(db, vaultId, true))!;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(await setVaultShare(db, vaultId, true)).toBe(code);
    expect(await sharedGearByCode(db, code)).not.toBeNull();
    expect(await setVaultShare(db, vaultId, false)).toBeNull();
    expect(await sharedGearByCode(db, code)).toBeNull();
    // on again is a different link; the old one stays dead
    const next = (await setVaultShare(db, vaultId, true))!;
    expect(next).not.toBe(code);
    expect(await sharedGearByCode(db, code)).toBeNull();
  });

  it("reads the owner's gear without food, and their chosen name", async () => {
    const code = (await setVaultShare(db, vaultId, true))!;
    const gear = (await sharedGearByCode(db, code.toLowerCase()))!;
    expect(gear.owner).toBe("Sam");
    expect(gear.items.map((i) => i.name)).toEqual(["Duplex"]);
  });

  it("names the owner only by a name they set, trimmed, as a list's byline does", async () => {
    const code = (await setVaultShare(db, vaultId, true))!;
    await db.update(users).set({ displayName: "  Sam  " });
    expect((await sharedGearByCode(db, code))!.owner).toBe("Sam");
    await db.update(users).set({ displayName: "   " });
    expect("owner" in (await sharedGearByCode(db, code))!).toBe(false);
    await db.update(users).set({ displayName: null });
    expect("owner" in (await sharedGearByCode(db, code))!).toBe(false);
  });

  it("answers nothing for a mistyped code, or a vault no account owns", async () => {
    const code = (await setVaultShare(db, vaultId, true))!;
    expect(await sharedGearByCode(db, "not-a-code")).toBeNull();
    await db.update(vaults).set({ userId: null }).where(eq(vaults.id, vaultId));
    expect(await sharedGearByCode(db, code)).toBeNull();
  });
});

describe("the gear link's preview", () => {
  const piece = (name: string, commonName: string) => vaultRow({ name, commonName });
  const gear = {
    owner: "Sam",
    items: [
      piece("X-Mid 2", "Tent"),
      piece("Revelation", "Quilt"),
      piece("NeoAir XLite", "Sleeping pad"),
      piece("Rapide SL", "Sleeping pad"),
      piece("Arc Haul", "Backpack"),
      vaultRow({ name: "Cook kit", kind: "kit", parts: [] }),
    ],
  };

  it("names the page by the owner's chosen name, and says its counts as one line", () => {
    expect(sharedGearTitle(gear)).toBe("Sam’s gear");
    expect(sharedGearTitle({})).toBe("Shared gear");
    expect(sharedGearSummary(gear)).toBe("5 pieces · 1 kit");
    expect(sharedGearSummary({ items: [piece("Duplex", "Tent")] })).toBe("1 piece");
  });

  it("draws a card of pieces, not a weight, with the kinds it holds most of and its kits", () => {
    expect(gearCardModel(gear)).toEqual({
      title: "Sam’s gear",
      big: { value: "5", unit: "pieces" },
      chips: [
        { label: "Sleep", value: "3" },
        { label: "Shelter", value: "1" },
        { label: "Packs", value: "1" },
        { label: "Kits", value: "1" },
      ],
    });
  });

  it("falls back to Shared gear when the owner's name has nothing the card can draw", () => {
    expect(gearCardModel({ owner: "山田", items: [] }).title).toBe("Shared gear");
  });
});
