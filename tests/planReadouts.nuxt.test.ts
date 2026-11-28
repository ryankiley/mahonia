// The Trip tab's READ-ONLY heights, and the calorie tooltip's pointer to the weight.
//
// A day's climb is an editable field, so it prints ungrouped ("1600") and parses back.
// The Climb chip and a day's drop are only read, and they went through the same
// formatter: "3200 ft" beside chips reading "3,100 kcal". They take the field's step
// and the reader's grouping. The tooltip said its body weight was "(assumed)" without
// saying that the field for it is at the foot of the tab, under every day.
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
// the walker's weight is one value for the whole device, so each case starts from none
beforeEach(() => useBodyWeight().set(null));
afterEach(() => useBodyWeight().set(null));

// two days in miles and feet: 488 m is 1,601 ft, which the day's field holds to 1600
const plan = (): ListSnapshot =>
  blankList({
    trailDistanceUnit: "mi",
    days: [
      { id: "d1", sortOrder: 0, distanceM: 12_000, ascentM: 488, descentM: 400 },
      { id: "d2", sortOrder: 1, distanceM: 12_000, ascentM: 488 },
    ],
  });
const mountPlan = () => mount(TrailPlanPanel, { props: { snapshot: plan(), personFilter: null } });
const burnTips = (w: ReturnType<typeof mountPlan>) =>
  w.findAllComponents(Tooltip).map((t) => String(t.props("text"))).filter((t) => t.startsWith("Walking and resting"));

describe("the plan's read-only heights", () => {
  it("groups the climb chip, at the step the day fields round to", () => {
    const w = mountPlan();
    const chip = w.findAll(".plan__chips .chip").find((c) => c.find(".t-label").text() === "Total climb")!;
    expect(chip.find(".t-num").text()).toBe("3,200 ft");
  });

  // The days' sum counts only climbs that were typed, and on a routed list most are read
  // off the file: beside the route's own climb it was a partial figure, so it stands down.
  it("leaves the climb to the route's own figure once there is one", () => {
    const w = mount(TrailPlanPanel, { props: { snapshot: { ...plan(), trailAscentM: 1_200 }, personFilter: null } });
    const labels = w.findAll(".plan__chips .chip .t-label").map((l) => l.text());
    expect(labels).toContain("Route climb");
    expect(labels.filter((l) => /climb/i.test(l))).toEqual(["Route climb"]);
  });

  it("groups a day's drop, and leaves the editable climb beside it ungrouped", () => {
    const w = mountPlan();
    const day = w.findAll(".plan__day")[0]!;
    expect(day.get(".plan__drop .t-num").text()).toBe("1,310 ft");
    expect(day.get<HTMLInputElement>('input[aria-label^="Climb on day"]').element.value).toBe("1600");
  });
});

describe("the calorie tooltip", () => {
  it("says where the assumed weight is set", () => {
    const tips = burnTips(mountPlan());
    expect(tips).toHaveLength(2);
    expect(tips[0]).toBe("Walking and resting, at 70 kg (assumed). Set your weight below the days. Good to about ±20%.");
  });

  it("drops the pointer once a weight is set", () => {
    useBodyWeight().set(82_000);
    const tips = burnTips(mountPlan());
    expect(tips[0]).toBe("Walking and resting, at 82 kg. Good to about ±20%.");
  });
});
