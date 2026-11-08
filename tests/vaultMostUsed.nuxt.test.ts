// The top of My Gear: the pieces you pack most, as tiles. Ranked by timesSeen (the lists
// that reached for a piece), gone until there's a history to rank, and each tile names
// what the piece IS, because a model name alone can pass for something else.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import VaultMostUsed from "~/components/VaultMostUsed.vue";
import type { VaultEntry } from "~~/shared/vault";

enableAutoUnmount(afterEach);

const entry = (id: number, name: string, timesSeen: number, extra: Partial<VaultEntry> = {}): VaultEntry => ({
  id,
  name,
  weightMg: 100_000,
  normKey: name.toLowerCase(),
  timesSeen,
  lastUsedAt: "2026-11-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  ...extra,
});

const shelf = (items: VaultEntry[]) => mount(VaultMostUsed, { props: { items, unit: "g" } });
const names = (w: ReturnType<typeof shelf>) => w.findAll(".mu__name").map((n) => n.text());

describe("the Most used shelf", () => {
  it("shows the six pieces packed most, most first", () => {
    const items = [5, 40, 12, 3, 287, 90, 7, 1].map((n, i) => entry(i + 1, `Piece ${n}`, n));
    expect(names(shelf(items))).toEqual(["Piece 287", "Piece 90", "Piece 40", "Piece 12", "Piece 7", "Piece 5"]);
  });

  it("is absent until three pieces have any history", () => {
    const fresh = [entry(1, "A", 1), entry(2, "B", 4), entry(3, "C", 2), entry(4, "D", 1)];
    expect(shelf(fresh).find(".mu").exists()).toBe(false);
    expect(shelf([...fresh, entry(5, "E", 3)]).find(".mu").exists()).toBe(true);
  });

  it("names the gear type under the model, and the brand when there is no type", () => {
    const w = shelf([
      entry(1, "Hiker Boot Midweight", 50, { brand: "Darn Tough", commonName: "Socks" }),
      entry(2, "NU25", 40, { brand: "Nitecore" }),
      entry(3, "Cormac Hoody", 30, { commonName: "Sun hoodie" }),
    ]);
    expect(w.findAll(".mu__meta").map((m) => m.text())).toEqual(["Socks", "Nitecore", "Sun hoodie"]);
  });

  it("opens the piece from its tile", async () => {
    const items = [entry(1, "A", 9), entry(2, "B", 8), entry(3, "C", 7)];
    const w = shelf(items);
    await w.findAll(".mu__tile")[1]!.trigger("click");
    expect(w.emitted("open")?.[0]?.[0]).toMatchObject({ id: 2 });
    expect(w.find(".mu button:not(.mu__tile)").exists()).toBe(false);
  });
});
