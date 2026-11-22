// A GHOST DAY HAS NOTHING TO FOLD. The dates decide how many days a plan shows, and a
// day nobody has typed into yet is a row with no entity behind it (TrailPlanPanel's
// `days`). A collapse is remembered against a day's id, so that row's chevron had
// nothing to write to: it drew, took the press and did nothing — on every day of a
// freshly dated trip. The chevron belongs to a day that exists.
import { afterEach, describe, expect, it } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import TrailPlanPanel from "~/components/TrailPlanPanel.vue";
import { computeTotals } from "~~/shared/weights";
import type { ListSnapshot } from "~~/shared/types";
import { blankList } from "./helpers/list";

// the panel only calls the controller from its handlers; none run here
mockNuxtImport("useGearList", () => () => ({}));

enableAutoUnmount(afterEach);

describe("the plan's day chevrons", () => {
  it("draws one for a stored day and none for a ghost", () => {
    // two days by the calendar, one of them given a distance
    const snapshot: ListSnapshot = blankList({
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      days: [{ id: "d1", sortOrder: 0, distanceM: 8000 }],
    });
    const w = mount(TrailPlanPanel, { props: { snapshot, totals: computeTotals(snapshot) } });
    const days = w.findAll(".plan__day");
    expect(days).toHaveLength(2);
    expect(days[0]!.find(".folder__collapse").exists()).toBe(true);
    expect(days[1]!.find(".folder__collapse").exists()).toBe(false);
    // the ghost keeps the rest of its header: its name and its remove
    expect(days[1]!.find(".plan__name").exists()).toBe(true);
    expect(days[1]!.find(".plan__del").exists()).toBe(true);
  });
});
