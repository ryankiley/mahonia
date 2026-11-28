// What a day is like, read off the route's profile, and how its estimates explain
// themselves.
//
// The facts were two sentences under the day's figures, seven numbers in four wrapped
// lines on a phone. They are one fact a line now, each figure marked as one so the line
// can be scanned by its numbers. And each estimate had a (?) after it; the figure is the
// explanation's trigger instead, a button so a keyboard can reach it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import TrailPlanPanel from "~/components/TrailPlanPanel.vue";
import Tooltip from "~/components/Tooltip.vue";
import { useBodyWeight } from "~/composables/useBodyWeight";
import type { ListSnapshot } from "~~/shared/types";
import { blankList } from "./helpers/list";

// the panel only calls the controller from its handlers; none run here
mockNuxtImport("useGearList", () => () => ({}));

enableAutoUnmount(afterEach);
beforeEach(() => useBodyWeight().set(null));
afterEach(() => useBodyWeight().set(null));

// 12 km in one day: up from 1,000 m to a 2,500 m pass at two fifths of the way, then
// down to a camp at 600 m, 400 m under the trailhead
const profile = Array.from({ length: 121 }, (_, i) => {
  const t = i / 120;
  return Math.round(t < 0.4 ? 1000 + (t / 0.4) * 1500 : 2500 - ((t - 0.4) / 0.6) * 1900);
});
const plan = (): ListSnapshot =>
  blankList({
    trailDistanceUnit: "km",
    trailDistanceM: 12_000,
    trailProfile: profile.join(","),
    trailAscentM: 1500,
    trailDescentM: 1900,
    days: [{ id: "d1", sortOrder: 0, distanceM: 12_000 }],
  });
const mountPlan = () => mount(TrailPlanPanel, { props: { snapshot: plan(), personFilter: null } });

describe("a day's facts", () => {
  it("are one fact a line, with each figure marked", () => {
    const w = mountPlan();
    const lines = w.findAll(".plan__day .plan__facts .plan__fact");
    expect(lines.map((l) => l.text())).toEqual([
      "Finish 600 m, about 3 °C warmer",
      "High point 2,500 m",
      "Longest climb 1,500 m over 4.8 km",
      "Steepest 31% up at 600 m",
    ]);
    // the figures, and only the figures, stand forward of the words
    expect(lines.map((l) => l.findAll(".plan__fig").map((f) => f.text()))).toEqual([
      ["600 m", "3 °C"],
      ["2,500 m"],
      ["1,500 m", "4.8 km"],
      ["31%", "600 m"],
    ]);
  });

  it("say nothing for a day with no distance", () => {
    const snapshot = { ...plan(), days: [{ id: "d1", sortOrder: 0 }] };
    const w = mount(TrailPlanPanel, { props: { snapshot, personFilter: null } });
    expect(w.find(".plan__facts").exists()).toBe(false);
  });
});

describe("a day's estimates", () => {
  it("explain themselves from the figure, with no (?) beside it", () => {
    const w = mountPlan();
    const day = w.get(".plan__day");
    // each estimate is a button that says what it is, so a keyboard can reach its words
    expect(day.findAll("button.plan__est").map((b) => b.attributes("aria-label"))).toEqual([
      "Walking time 5–5.5 hr",
      "About 3,100 kcal burned",
    ]);
    // and the tooltip is hung on that button, not on a mark after it
    const tips = w.findAllComponents(Tooltip).filter((t) => t.find(".plan__est").exists());
    expect(tips.map((t) => String(t.props("text")).split(".")[0])).toEqual([
      "Walking time only, no breaks",
      "Walking and resting, at 70 kg (assumed)",
    ]);
    expect(day.find('[aria-label^="How the"]').exists()).toBe(false);
  });
});
