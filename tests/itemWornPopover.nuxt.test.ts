// THE CLASS POPOVER: ONE CHOICE, AND HOW MANY ARE WORN. A row counts as one thing —
// base, worn or consumable — and its one mark opens that choice as a radio group. It was
// two toggles with a card each, and each card had to say "Turns the other off" before
// its switch; a choice of three says so by being one control. The lit option is not a
// way off: pressing it writes nothing.
//
// On a row of several, worn also has to say how many: all of them, or some. So under the
// choice is a STEPPER with a figure you can type, clamped to the line, with "All" beside
// it; the line over it is the count itself ("2 worn · 1 packed") in every state; and
// asking for the count the row already has writes nothing. (A count on the row itself
// was tried and taken out: the hover tooltip and the mark's name still say "2 of 3".)
//
// Rendered through the real <ItemRow>, over the real reducer, because what is under test
// is what the row stores for each press and which branch of the template draws.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount } from "@vue/test-utils";
import { mountRowOver, rowProvides } from "./helpers/itemRow";
import type { Item, ListSnapshot } from "~~/shared/types";
import { blankList, folder, item as baseItem } from "./helpers/list";
import { gearListStub, quietVaultAccess } from "./helpers/gearList";
import { useItemMenu } from "~/composables/useItemMenu";

registerEndpoint("/api/catalog/search", () => ({ results: [] }));
registerEndpoint("/api/catalog/use", { method: "POST", handler: () => ({ ok: true }) });

mockNuxtImport("useVaultAccess", () => () => quietVaultAccess());

const snapshot = ref<ListSnapshot>(blankList());
mockNuxtImport("useGearList", () => () => gearListStub({ snapshot }));

enableAutoUnmount(afterEach);

const socks = (over: Partial<Item> = {}): Item =>
  baseItem({ id: "socks", name: "Hiking socks", unitWeightMg: 60_000, qty: 3, classification: "base", ...over });

const mountRow = (row: Item) => mountRowOver(snapshot, [{ ...row }]);
const row = () => snapshot.value.items[0]!;

async function openClass(w: ReturnType<typeof mountRow>) {
  await w.get(".item__clsbtn").trigger("click");
  await nextTick();
  const pop = w.get('[role="dialog"][aria-label="Counts as"]');
  const option = (word: string) => pop.get(`[role="radio"][aria-label^="${word}"]`);
  const field = () => pop.get<HTMLInputElement>('input[aria-label="How many are worn"]');
  return {
    pop,
    base: () => option("Base"),
    worn: () => option("Worn"),
    consumable: () => option("Consumable"),
    chosen: () => pop.findAll('[role="radio"][aria-checked="true"]').map((o) => o.text()),
    fewer: () => pop.get('button[aria-label="One fewer worn"]'),
    more: () => pop.get('button[aria-label="One more worn"]'),
    all: () => pop.get(".item__split"),
    field,
    count: () => field().element.value,
    line: () => pop.find(".item__poplabel").text(),
    type: async (text: string) => {
      field().element.value = text;
      await field().trigger("change");
    },
  };
}
const disabled = (b: { attributes: (name: string) => string | undefined }) => b.attributes("disabled") !== undefined;

beforeEach(() => {
  snapshot.value = blankList();
  useItemMenu().close();
});

describe("how many are worn is a stepper, with All beside it", () => {
  it("choosing Worn wears them all, and says so: the figure and the line at 3", async () => {
    const w = mountRow(socks());
    const p = await openClass(w);
    expect(p.count()).toBe("0");
    expect(p.line()).toBe("0 worn · 3 packed");
    expect(disabled(p.all())).toBe(false);
    expect(disabled(p.fewer())).toBe(true);

    await p.worn().trigger("click");
    expect(row().classification).toBe("worn");
    expect(p.chosen()).toEqual(["Worn"]);
    expect(p.count()).toBe("3");
    expect(p.line()).toBe("3 worn · 0 packed");
    // All is a shortcut, not a state: at the top it stands down with the +, unlit
    expect(disabled(p.all())).toBe(true);
    expect(p.all().attributes("aria-pressed")).toBeUndefined();
    expect(p.all().classes()).not.toContain("is-active");
    expect(disabled(p.more())).toBe(true);
  });

  it("steps from none, through a part, to all and back down to none", async () => {
    const w = mountRow(socks());
    const p = await openClass(w);

    await p.more().trigger("click");
    expect(row()).toMatchObject({ wornQty: 1 });
    expect(p.line()).toBe("1 worn · 2 packed");
    expect(p.chosen()).toEqual(["Worn"]);

    await p.more().trigger("click");
    expect(row()).toMatchObject({ wornQty: 2 });

    // the last step up is not a split of three-of-three: it is the Worn class
    await p.more().trigger("click");
    expect(row().classification).toBe("worn");
    expect(row().wornQty ?? 0).toBe(0);
    expect(disabled(p.all())).toBe(true);

    await p.fewer().trigger("click");
    expect(row().classification).not.toBe("worn");
    expect(row()).toMatchObject({ wornQty: 2 });
    expect(disabled(p.all())).toBe(false);

    await p.fewer().trigger("click");
    await p.fewer().trigger("click");
    expect(row().wornQty ?? 0).toBe(0);
    expect(p.chosen()).toEqual(["Base"]);
    expect(p.line()).toBe("0 worn · 3 packed");
    expect(disabled(p.fewer())).toBe(true);
  });

  it("takes a typed figure of any size, clamped to the line", async () => {
    const w = mountRow(socks({ qty: 40 }));
    const p = await openClass(w);

    await p.type("20");
    expect(row()).toMatchObject({ wornQty: 20 });
    expect(p.line()).toBe("20 worn · 20 packed");

    // past the count is all of them, and the box reads what the row holds
    await p.type("99");
    expect(row().classification).toBe("worn");
    expect(p.count()).toBe("40");

    await p.type("-5");
    expect(row().classification).not.toBe("worn");
    expect(row().wornQty ?? 0).toBe(0);
    expect(p.count()).toBe("0");

    // nothing typed is not a zero: the row is left alone and the box put back
    await p.type("7");
    const before = snapshot.value;
    await p.type("");
    expect(snapshot.value).toBe(before);
    expect(p.count()).toBe("7");
  });

  it("asking for the count the row already has writes nothing", async () => {
    // the stub controller replaces the snapshot on every updateItem, as the live one
    // saves on every dispatch, so the same object is the proof
    const w = mountRow(socks({ wornQty: 2 }));
    const p = await openClass(w);
    const before = snapshot.value;
    await p.type("2");
    expect(snapshot.value).toBe(before);

    await p.all().trigger("click");
    expect(row().classification).toBe("worn");
    const worn = snapshot.value;
    await p.type("40");
    expect(snapshot.value).toBe(worn);
    expect(p.count()).toBe("3");
  });

  it("All stands down on a row worn through its folder, leaving that default unstamped", async () => {
    const w = mountRowOver(snapshot, [socks({ classification: null })], rowProvides(), {
      folders: [folder({ defaultClassification: "worn" })],
    });
    const p = await openClass(w);
    expect(disabled(p.all())).toBe(true);
    expect(p.line()).toBe("3 worn · 0 packed");
    // and a typed "all of them" is the count it already has: nothing written
    const before = snapshot.value;
    await p.type("3");
    expect(snapshot.value).toBe(before);
    expect(row().classification).toBeNull();

    // stepping down from the inherited class does write: an explicit base line, split
    await p.fewer().trigger("click");
    expect(row()).toMatchObject({ classification: "base", wornQty: 2 });
  });

  it("is not offered on one of one, or on a consumable", async () => {
    for (const over of [{ qty: 1 }, { classification: "consumable" }] as const) {
      const w = mountRow(socks(over));
      const pop = (await openClass(w)).pop;
      expect(pop.find('input[aria-label="How many are worn"]').exists(), JSON.stringify(over)).toBe(false);
      expect(pop.find(".item__split").exists()).toBe(false);
      w.unmount();
      useItemMenu().close();
    }
  });
});

describe("one class a row: the choice is one control", () => {
  it("offers the three, with the row's own lit and nothing to explain", async () => {
    const w = mountRow(socks());
    const p = await openClass(w);
    expect(p.pop.findAll('[role="radio"]').map((o) => o.text())).toEqual(["Base", "Worn", "Consumable"]);
    expect(p.chosen()).toEqual(["Base"]);
    expect(p.pop.text()).not.toContain("Turns");
    expect(p.pop.find('[role="switch"]').exists()).toBe(false);
  });

  it("moves a consumable to worn, and a worn or part-worn row to consumable, dropping the split", async () => {
    const w = mountRow(socks({ name: "Granola bar", classification: "consumable" }));
    const p = await openClass(w);
    expect(p.chosen()).toEqual(["Consumable"]);
    await p.worn().trigger("click");
    expect(row().classification).toBe("worn");
    expect(p.chosen()).toEqual(["Worn"]);
    w.unmount();
    useItemMenu().close();

    for (const over of [{ classification: "worn" }, { wornQty: 1 }] as const) {
      const w2 = mountRow(socks(over));
      const p2 = await openClass(w2);
      expect(p2.chosen(), JSON.stringify(over)).toEqual(["Worn"]);
      await p2.consumable().trigger("click");
      expect(row()).toMatchObject({ classification: "consumable" });
      expect(row().wornQty ?? 0).toBe(0);
      w2.unmount();
      useItemMenu().close();
    }
  });

  it("goes back to base from either, and pins base where the folder says otherwise", async () => {
    const w = mountRow(socks({ classification: "worn" }));
    const p = await openClass(w);
    await p.base().trigger("click");
    expect(row().classification).not.toBe("worn");
    expect(p.chosen()).toEqual(["Base"]);
    w.unmount();
    useItemMenu().close();

    const inWorn = mountRowOver(snapshot, [socks({ classification: null })], rowProvides(), {
      folders: [folder({ defaultClassification: "worn" })],
    });
    const p2 = await openClass(inWorn);
    expect(p2.chosen()).toEqual(["Worn"]);
    await p2.base().trigger("click");
    expect(row().classification).toBe("base");
  });

  it("the lit option writes nothing, a part-worn row's count included", async () => {
    // the stub controller replaces the snapshot on every updateItem, so the same object
    // is the proof
    for (const [over, word] of [[{}, "Base"], [{ classification: "worn" }, "Worn"], [{ wornQty: 2 }, "Worn"], [{ classification: "consumable" }, "Consumable"]] as const) {
      const w = mountRow(socks(over));
      const p = await openClass(w);
      const before = snapshot.value;
      await p.pop.get(`[role="radio"][aria-label^="${word}"]`).trigger("click");
      expect(snapshot.value, JSON.stringify(over)).toBe(before);
      w.unmount();
      useItemMenu().close();
    }
  });

  it("the arrows move the choice, one tab stop between the three", async () => {
    const w = mountRow(socks());
    const p = await openClass(w);
    expect(p.pop.findAll('[role="radio"]').map((o) => o.attributes("tabindex"))).toEqual(["0", "-1", "-1"]);
    await p.pop.get('[role="radiogroup"]').trigger("keydown", { key: "ArrowRight" });
    expect(row().classification).toBe("worn");
    await p.pop.get('[role="radiogroup"]').trigger("keydown", { key: "ArrowLeft" });
    expect(row().classification).not.toBe("worn");
    expect(p.chosen()).toEqual(["Base"]);
  });
});
