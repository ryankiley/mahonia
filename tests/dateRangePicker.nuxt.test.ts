// @vitest-environment nuxt
//
// The month grid's KEYBOARD contract — the part of <DateRangePicker> that can quietly
// commit the wrong date.
//
// The grid is one tab stop with a roving tabindex, and that pattern has two halves:
// move which cell claims tabindex="0", AND move real DOM focus with it. Shipping only
// the first half looks fine in a screenshot and is broken in use — setting
// tabindex="-1" on the element that currently holds focus does not blur it, so focus
// stays put while the tab stop walks away. Arrowing then appears inert, and Enter
// fires the day you started on. Worse, cells keyed by index made a month change patch
// the still-focused button in place, so it came back showing a different date, which
// Enter committed. None of that is visible to a unit test of the date helpers, so it
// is asserted here against a mounted component.
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DateRangePicker from "~/components/DateRangePicker.vue";

const mountCal = (props: { start?: string; end?: string } = {}) =>
  mount(DateRangePicker, { props, attachTo: document.body });

/** The day cell that currently holds the single tab stop. */
const tabStop = (w: ReturnType<typeof mountCal>) =>
  w.findAll('.cal__day').filter((d) => d.attributes("tabindex") === "0");

const press = async (w: ReturnType<typeof mountCal>, key: string) => {
  await w.find(".cal__grid").trigger("keydown", { key });
  await new Promise((r) => setTimeout(r, 0)); // the focus move awaits nextTick
};

describe("DateRangePicker keyboard", () => {
  it("gives the grid exactly one tab stop", () => {
    const w = mountCal({ start: "2026-08-04" });
    expect(tabStop(w)).toHaveLength(1);
    expect(tabStop(w)[0]!.attributes("data-iso")).toBe("2026-08-04");
    w.unmount();
  });

  it("moves the tab stop with the arrow keys", async () => {
    const w = mountCal({ start: "2026-08-04" });
    await press(w, "ArrowRight");
    expect(tabStop(w)[0]!.attributes("data-iso")).toBe("2026-08-05");
    await press(w, "ArrowDown");
    expect(tabStop(w)[0]!.attributes("data-iso")).toBe("2026-08-12");
    w.unmount();
  });

  it("carries the tab stop across a month boundary, and re-cursors to that month", async () => {
    // 4 Aug − 7 days = 28 Jul: the grid must follow, or the focused day isn't rendered
    const w = mountCal({ start: "2026-08-04" });
    await press(w, "ArrowUp");
    expect(w.find(".cal__month").text()).toContain("July");
    const stop = tabStop(w);
    expect(stop).toHaveLength(1);
    expect(stop[0]!.attributes("data-iso")).toBe("2026-07-28");
    w.unmount();
  });

  it("keeps a tab stop after the month buttons move the view", async () => {
    // `focused` used to be left behind in the old month, so NO rendered cell claimed
    // tabindex="0" and the whole grid dropped out of the tab order
    const w = mountCal({ start: "2026-08-04" });
    await w.find('[aria-label="Previous month"]').trigger("click");
    await w.find('[aria-label="Previous month"]').trigger("click");
    expect(w.find(".cal__month").text()).toContain("June");
    expect(tabStop(w)).toHaveLength(1);
    w.unmount();
  });

  it("clamps the day when the new month is shorter", async () => {
    const w = mountCal({ start: "2026-03-31" });
    await w.find('[aria-label="Previous month"]').trigger("click"); // → February
    expect(tabStop(w)[0]!.attributes("data-iso")).toBe("2026-02-28");
    w.unmount();
  });

  it("keys cells by date, so a month change replaces them rather than repainting", async () => {
    // the index-keyed version reused the focused <button> for a different day, which
    // is what let Enter commit a date nobody navigated to
    const w = mountCal({ start: "2026-08-04" });
    const before = w.find('[data-iso="2026-08-04"]').element;
    await press(w, "ArrowUp"); // into July
    const reused = w.find('[data-iso="2026-07-28"]').element;
    expect(reused).not.toBe(before);
    w.unmount();
  });

  it("seeds the tab stop inside the month it opens on, given only an end date", () => {
    // opening on the END's month while the tab stop pointed at today left the grid
    // with no tabbable cell at all
    const w = mountCal({ end: "2026-11-20" });
    expect(w.find(".cal__month").text()).toContain("November");
    expect(tabStop(w)).toHaveLength(1);
    w.unmount();
  });

  it("emits the day that holds focus, not the one it started on", async () => {
    const w = mountCal({ start: "2026-08-04" });
    await press(w, "ArrowUp"); // → 2026-07-28
    await w.find('[data-iso="2026-07-28"]').trigger("click");
    const last = w.emitted("update")?.at(-1)?.[0] as { start?: string };
    expect(last.start).toBe("2026-07-28");
    w.unmount();
  });
});
