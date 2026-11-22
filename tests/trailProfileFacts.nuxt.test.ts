// THE ROUTE'S CLIMB AND DROP, UNDER THE CHART. TrailProfile prints them itself unless the
// composing page says it carries them among its own figures (`facts`): the editor's
// planning view does, the shared view has no such row. The prop was declared optional
// with no default, and Vue casts an absent Boolean prop to false — so the shared view,
// which passes nothing, asked for the figures and never got them.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import TrailProfile from "~/components/TrailProfile.vue";

enableAutoUnmount(afterEach);

// a 5 km route that climbs and comes part of the way back down, one day long
const profile = Array.from({ length: 24 }, (_, i) => 1000 + (i < 16 ? i * 20 : (31 - i) * 20));
const mountProfile = (over: { facts?: boolean } = {}) =>
  mount(TrailProfile, {
    props: {
      profile,
      dayDistancesM: [5000],
      distanceUnit: "km",
      totalDistanceM: 5000,
      ascentM: 300,
      descentM: 140,
      ...over,
    },
  });

describe("the profile's own climb and drop figures", () => {
  it("are printed when the page doesn't say otherwise (the shared view)", () => {
    const w = mountProfile();
    expect(w.find(".tprofile").exists()).toBe(true);
    const facts = w.find(".tprofile__facts");
    expect(facts.exists()).toBe(true);
    expect(facts.text()).toContain("Elevation gain");
    expect(facts.text()).toContain("Elevation loss");
  });

  it("stand down where the page carries them itself (the planning view)", () => {
    const w = mountProfile({ facts: false });
    expect(w.find(".tprofile").exists()).toBe(true);
    expect(w.find(".tprofile__facts").exists()).toBe(false);
  });
});
