// The share page's Trip view against the editor's: where its mode bar sits, and the
// glyph a day's climb wears.
//
// The bar is the editor's own component in the same seat, under the same toolbar, and it
// sat 20px lower here: this page's column kept the top padding a title wants. A class on
// the column is what takes that padding down to the editor's when there is a bar, so it
// is what's checked (a test DOM lays nothing out). The climb wore an up-right arrow where
// the editor's day row wears the stairs.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import ReadonlyListView from "~/components/ReadonlyListView.vue";
import { useReadonlyList } from "~/composables/useReadonlyList";
import { StairsGlyph } from "~/icons/mahonia";
import type { ListSnapshot } from "~~/shared/types";
import { blankList } from "./helpers/list";

enableAutoUnmount(afterEach);

// the page's own wiring: the view-model's props, bound whole
const mountView = (list: ListSnapshot) =>
  mount(
    defineComponent({
      setup: () => {
        const { viewProps } = useReadonlyList(ref(list));
        return () => h(ReadonlyListView, viewProps.value);
      },
    }),
    { attachTo: document.body },
  );

const withTrip = () =>
  blankList({
    startDate: "2026-07-01",
    endDate: "2026-07-02",
    days: [
      { id: "d1", sortOrder: 0, distanceM: 12_000, ascentM: 900 },
      { id: "d2", sortOrder: 1, distanceM: 9_000, ascentM: 400 },
    ],
  });

describe("the share page's mode bar", () => {
  it("starts the column at the editor's step when there is a bar", () => {
    const w = mountView(withTrip());
    expect(w.find('[role="radiogroup"]').exists()).toBe(true);
    expect(w.get("main.view").classes()).toContain("has-modes");
  });

  it("keeps the title's own top padding on a list with no trip, which has no bar", () => {
    const w = mountView(blankList());
    expect(w.find('[role="radiogroup"]').exists()).toBe(false);
    expect(w.get("main.view").classes()).not.toContain("has-modes");
  });
});

describe("a shared day's climb", () => {
  it("wears the stairs the editor's day row does", async () => {
    const w = mountView(withTrip());
    await w.findAll('[role="radio"]').find((b) => b.text().includes("Trip"))!.trigger("click");
    const figs = w.findAll(".view__day")[0]!.findAll(".view__dayfig");
    expect(figs).toHaveLength(2);
    const stairs = (StairsGlyph[0]![1] as { d: string }).d;
    expect(figs[1]!.get("svg path").attributes("d")).toBe(stairs);
    expect(figs[1]!.text()).toBe("2,950 ft");
  });
});
