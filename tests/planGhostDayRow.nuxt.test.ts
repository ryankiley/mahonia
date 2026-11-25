// A GHOST DAY KEEPS ITS ROW WHEN IT BECOMES REAL. A day the dates imply and nobody has
// typed into is a row with no entity behind it; the first figure committed to it adds
// the day. The rows were keyed by the day's id, or by position while there was none, so
// that commit changed the row's key and Vue rebuilt it: the field just typed into was
// replaced by a copy, and a Tab out of it left focus on <body>. The row is the same
// row before and after, and so is every field in it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import TrailPlanPanel from "~/components/TrailPlanPanel.vue";
import type { ListSnapshot, TripDay } from "~~/shared/types";
import { blankList } from "./helpers/list";

// the controller's two verbs a day's field calls, applied to the mounted panel's list
// the way the editor's are: the snapshot the panel is handed is replaced
let wrapper: VueWrapper;
const days = () => [...((wrapper.props() as { snapshot: ListSnapshot }).snapshot.days ?? [])];
const setDays = (next: TripDay[]) =>
  wrapper.setProps({ snapshot: { ...(wrapper.props() as { snapshot: ListSnapshot }).snapshot, days: next } });
let made = 0;
const controller = {
  addDay: vi.fn(() => void setDays([...days(), { id: `new${++made}`, sortOrder: days().length }])),
  updateDay: vi.fn((id: string, patch: Partial<TripDay>) =>
    void setDays(days().map((d) => (d.id === id ? ({ ...d, ...patch } as TripDay) : d))),
  ),
};
mockNuxtImport("useGearList", () => () => controller);

enableAutoUnmount(afterEach);
afterEach(() => {
  made = 0;
  vi.clearAllMocks();
});

/** three days by the calendar, the first of them stored */
function mountPlan() {
  wrapper = mount(TrailPlanPanel, {
    props: {
      snapshot: blankList({
        startDate: "2026-07-01",
        endDate: "2026-07-03",
        days: [{ id: "d1", sortOrder: 0, distanceM: 8000 }],
      }),
      personFilter: null,
    },
    attachTo: document.body,
  });
}
const row = (i: number) => wrapper.findAll(".plan__day")[i]!;
const distance = (i: number) => row(i).get<HTMLInputElement>('input[aria-label^="Distance on day"]');
const climb = (i: number) => row(i).get<HTMLInputElement>('input[aria-label^="Climb on day"]');

describe("a blank day's first figure", () => {
  it("keeps the row, and the field it was typed into, when the day becomes real", async () => {
    mountPlan();
    const li = row(1).element;
    const field = distance(1).element;
    const next = climb(1).element;
    // Tab out of the field: focus is on the next one by the time the change has applied
    next.focus();
    field.value = "9";
    await distance(1).trigger("change");
    await flushPromises();

    expect(controller.addDay).toHaveBeenCalledTimes(1);
    expect(controller.updateDay).toHaveBeenCalledWith("new1", { distanceM: expect.any(Number) });
    // the day is real now: its chevron has arrived
    expect(row(1).find(".folder__collapse").exists()).toBe(true);
    expect(row(1).element).toBe(li);
    expect(document.body.contains(field)).toBe(true);
    expect(distance(1).element).toBe(field);
    expect(document.activeElement).toBe(next);
  });

  it("keeps every row a first figure on a later day makes real", async () => {
    mountPlan();
    const rows = [row(1).element, row(2).element];
    const field = distance(2).element;
    field.value = "5";
    await distance(2).trigger("change");
    await flushPromises();

    // day 2 is filled in on the way, so the figure lands on day 3
    expect(controller.addDay).toHaveBeenCalledTimes(2);
    expect(controller.updateDay).toHaveBeenCalledWith("new2", { distanceM: expect.any(Number) });
    expect([row(1).element, row(2).element]).toEqual(rows);
    expect(distance(2).element).toBe(field);
  });

  it("gives a ghost that follows an adopted one a row of its own", async () => {
    mountPlan();
    distance(1).element.value = "9";
    await distance(1).trigger("change");
    await flushPromises();
    const adopted = row(1).element;
    // Day 1 goes: the adopted day is first now, and the day after it is a ghost at the
    // position the adopted one was a ghost in. A key shared by the two would be a
    // duplicate, which Vue warns about and then patches the wrong row.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setDays(days().filter((d) => d.id !== "d1"));
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/duplicate keys/i);
    warn.mockRestore();
    const live = wrapper.findAll(".plan__day").filter((r) => r.find(".folder__collapse").exists());
    expect(live.map((r) => r.element)).toContain(adopted);
  });
});
