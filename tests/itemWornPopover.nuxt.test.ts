// THE WORN POPOVER ON A ROW OF SEVERAL. "Worn" is a switch, and on a row of three it has
// to say how many: all of them, or some. It used to offer the part counts as chips (1, 2),
// so flipping the switch wore all three while lighting no count and printing no line, and
// picking the lit count again un-wore the row. Then the chips grew an "All" and a ceiling
// of four, which was the card's width talking, not anything about gear.
//
// So the count is a STEPPER with a figure you can type, clamped to the line, with "All"
// beside it; the line over it is the count itself ("2 worn · 1 packed") in every state;
// and asking for the count the row already has writes nothing. (A count on the row
// itself was tried and taken out: the hover tooltip and the control's name still say
// "2 of 3".) And because a row holds ONE class, each popover says so before its switch
// takes the other one off.
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

async function openWorn(w: ReturnType<typeof mountRow>) {
  await w.get('button[aria-label^="Worn"]').trigger("click");
  await nextTick();
  const pop = w.get('[role="dialog"][aria-label="Worn"]');
  const field = () => pop.get<HTMLInputElement>('input[aria-label="How many are worn"]');
  return {
    pop,
    sw: () => pop.get('[role="switch"]'),
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
  it("the switch alone wears them all, and says so: All lit, the figure and the line at 3", async () => {
    const w = mountRow(socks());
    const p = await openWorn(w);
    expect(p.count()).toBe("0");
    expect(p.line()).toBe("0 worn · 3 packed");
    expect(disabled(p.all())).toBe(false);
    expect(disabled(p.fewer())).toBe(true);

    await p.sw().trigger("click");
    expect(row().classification).toBe("worn");
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
    const p = await openWorn(w);

    await p.more().trigger("click");
    expect(row()).toMatchObject({ wornQty: 1 });
    expect(p.line()).toBe("1 worn · 2 packed");
    expect(p.sw().attributes("aria-checked")).toBe("true");

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
    expect(p.sw().attributes("aria-checked")).toBe("false");
    expect(p.line()).toBe("0 worn · 3 packed");
    expect(disabled(p.fewer())).toBe(true);
  });

  it("takes a typed figure of any size, clamped to the line", async () => {
    const w = mountRow(socks({ qty: 40 }));
    const p = await openWorn(w);

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
    const p = await openWorn(w);
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
    const p = await openWorn(w);
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
      const pop = (await openWorn(w)).pop;
      expect(pop.find('input[aria-label="How many are worn"]').exists(), JSON.stringify(over)).toBe(false);
      expect(pop.find(".item__split").exists()).toBe(false);
      w.unmount();
      useItemMenu().close();
    }
  });
});

describe("one class a row: each popover says what its switch takes off", () => {
  it("the worn popover on a consumable row", async () => {
    const w = mountRow(socks({ name: "Granola bar", classification: "consumable" }));
    const p = await openWorn(w);
    expect(p.pop.text()).toContain("Turns Consumable off");
    // the switch carries the line as its description, so it is heard before the press
    const sw = p.sw();
    expect(p.pop.get(`#${sw.attributes("aria-describedby")}`).text()).toBe("Turns Consumable off");
    await sw.trigger("click");
    expect(row().classification).toBe("worn");
    expect(p.pop.text()).not.toContain("Turns Consumable off");
    expect(sw.attributes("aria-describedby")).toBeUndefined();
  });

  it("the consumable popover on a worn row, a part-worn one included", async () => {
    for (const over of [{ classification: "worn" }, { wornQty: 1 }] as const) {
      const w = mountRow(socks(over));
      await w.get('button[aria-label^="Consumable"]').trigger("click");
      await nextTick();
      const pop = w.get('[role="dialog"][aria-label="Consumable"]');
      expect(pop.text(), JSON.stringify(over)).toContain("Turns Worn off");
      const sw = pop.get('[role="switch"][aria-label^="Consumable"]');
      expect(pop.get(`#${sw.attributes("aria-describedby")}`).text()).toBe("Turns Worn off");
      await sw.trigger("click");
      expect(row()).toMatchObject({ classification: "consumable" });
      expect(row().wornQty ?? 0).toBe(0);
      expect(pop.text()).not.toContain("Turns Worn off");
      w.unmount();
      useItemMenu().close();
    }
  });

  it("says nothing on a row that is neither", async () => {
    const w = mountRow(socks());
    const p = await openWorn(w);
    expect(p.pop.text()).not.toContain("Turns");
  });
});
