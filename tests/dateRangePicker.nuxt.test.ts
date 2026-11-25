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
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import DateRangePicker from "~/components/DateRangePicker.vue";

enableAutoUnmount(afterEach);

const mountCal = (props: { start?: string; end?: string } = {}) =>
  mount(DateRangePicker, { props, attachTo: document.body });

/** The day cell that currently holds the single tab stop. */
const tabStop = (w: ReturnType<typeof mountCal>) =>
  w.findAll('.cal__day').filter((d) => d.attributes("tabindex") === "0");

const press = async (w: ReturnType<typeof mountCal>, key: string) => {
  await w.find(".cal__grid").trigger("keydown", { key });
  await nextTick(); // the focus move awaits nextTick
};

describe("DateRangePicker keyboard", () => {
  it("gives the grid exactly one tab stop", () => {
    const w = mountCal({ start: "2026-08-04" });
    expect(tabStop(w)).toHaveLength(1);
    expect(tabStop(w)[0]!.attributes("data-iso")).toBe("2026-08-04");
  });

  it("moves the tab stop with the arrow keys", async () => {
    const w = mountCal({ start: "2026-08-04" });
    await press(w, "ArrowRight");
    expect(tabStop(w)[0]!.attributes("data-iso")).toBe("2026-08-05");
    await press(w, "ArrowDown");
    expect(tabStop(w)[0]!.attributes("data-iso")).toBe("2026-08-12");
  });

  it("carries the tab stop across a month boundary, and re-cursors to that month", async () => {
    // 4 Aug − 7 days = 28 Jul: the grid must follow, or the focused day isn't rendered
    const w = mountCal({ start: "2026-08-04" });
    await press(w, "ArrowUp");
    expect(w.find(".cal__month").text()).toContain("July");
    const stop = tabStop(w);
    expect(stop).toHaveLength(1);
    expect(stop[0]!.attributes("data-iso")).toBe("2026-07-28");
  });

  it("keeps a tab stop after the month buttons move the view", async () => {
    // `focused` used to be left behind in the old month, so NO rendered cell claimed
    // tabindex="0" and the whole grid dropped out of the tab order
    const w = mountCal({ start: "2026-08-04" });
    await w.find('[aria-label="Previous month"]').trigger("click");
    await w.find('[aria-label="Previous month"]').trigger("click");
    expect(w.find(".cal__month").text()).toContain("June");
    expect(tabStop(w)).toHaveLength(1);
  });

  it("clamps the day when the new month is shorter", async () => {
    const w = mountCal({ start: "2026-03-31" });
    await w.find('[aria-label="Previous month"]').trigger("click"); // → February
    expect(tabStop(w)[0]!.attributes("data-iso")).toBe("2026-02-28");
  });

  it("keys cells by date, so a month change replaces them rather than repainting", async () => {
    // the index-keyed version reused the focused <button> for a different day, which
    // is what let Enter commit a date nobody navigated to
    const w = mountCal({ start: "2026-08-04" });
    const before = w.find('[data-iso="2026-08-04"]').element;
    await press(w, "ArrowUp"); // into July
    const reused = w.find('[data-iso="2026-07-28"]').element;
    expect(reused).not.toBe(before);
  });

  it("seeds the tab stop inside the month it opens on, given only an end date", () => {
    // opening on the END's month while the tab stop pointed at today left the grid
    // with no tabbable cell at all
    const w = mountCal({ end: "2026-11-20" });
    expect(w.find(".cal__month").text()).toContain("November");
    expect(tabStop(w)).toHaveLength(1);
  });

  it("emits the day that holds focus, not the one it started on", async () => {
    const w = mountCal({ start: "2026-08-04" });
    await press(w, "ArrowUp"); // → 2026-07-28
    await w.find('[data-iso="2026-07-28"]').trigger("click");
    const last = w.emitted("update")?.at(-1)?.[0] as { start?: string };
    expect(last.start).toBe("2026-07-28");
  });
});

// A day cell's text is its digit, and the weekday letters above it are hidden from a
// screen reader, so the cell's name has to carry the whole date.
describe("DateRangePicker day names", () => {
  it("names each day in full, and leaves its selection to aria-selected", () => {
    const w = mountCal({ start: "2026-08-04", end: "2026-08-06" });
    const day = w.get('[data-iso="2026-08-04"]');
    expect(day.attributes("aria-label")).toBe("Tuesday, August 4, 2026");
    expect(day.attributes("aria-selected")).toBe("true");
    expect(day.text()).toBe("4");
    expect(w.get('[data-iso="2026-08-31"]').attributes("aria-label")).toBe("Monday, August 31, 2026");
    expect(w.get('[data-iso="2026-08-31"]').attributes("aria-selected")).toBe("false");
  });

  it("says which day is today, the one the grid rings", () => {
    const w = mountCal();
    const today = w.get(".cal__day.is-today");
    expect(today.attributes("aria-label")).toMatch(/^Today, \w+day, \w+ \d{1,2}, \d{4}$/);
    const others = w.findAll(".cal__day:not(.is-today)");
    expect(others.length).toBeGreaterThan(20);
    for (const d of others) expect(d.attributes("aria-label")).not.toContain("Today");
  });
});
