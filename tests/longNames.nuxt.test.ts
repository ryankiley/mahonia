// Long names, in the two places a person's name sits in chrome: the editor headline's
// caption ("Ryan’s pack") and the people filter's chips. happy-dom lays nothing out, so
// whether anything actually clips is a thing to look at in a browser; what this pins is
// the markup the clipping depends on: the part that may give way in a box of its own,
// the part that must survive outside it, and the full name kept where a pointer finds it.
import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import Headline from "~/components/Headline.vue";
import PeopleBar from "~/components/PeopleBar.vue";
import { UNASSIGNED } from "~~/shared/people";
import type { Person } from "~~/shared/types";

enableAutoUnmount(afterEach);

// the longest realistic name, near the 60-character cap people names are stored under
const LONG = "Aleksandra Wiśniewska-Kowalczyk of the Northwind Holdings";

const headline = (caption?: string | { name: string; suffix: string }) =>
  mount(Headline, {
    props: {
      value: "4.2",
      unit: "kg",
      options: [{ key: "kg", label: "kg" }],
      label: "Weight unit",
      caption,
    },
  });

describe("the headline caption", () => {
  it("clips only the name and keeps the suffix outside the clipped box", () => {
    const w = headline({ name: LONG, suffix: "’s pack" });
    const name = w.get(".headline__captionname");
    expect(name.text()).toBe(LONG);
    expect(name.classes()).toContain("t-clip");
    // the suffix is its own element, not inside the one that clips
    const suffix = w.get(".headline__captionsuffix");
    expect(suffix.text()).toBe("’s pack");
    expect(name.element.contains(suffix.element)).toBe(false);
    expect(w.get(".headline__caption").text()).toBe(`${LONG}’s pack`);
  });

  it("still takes a plain string, clipped whole", () => {
    const w = headline("Unassigned gear");
    expect(w.get(".headline__captionname").text()).toBe("Unassigned gear");
    expect(w.find(".headline__captionsuffix").exists()).toBe(false);
  });

  it("draws no caption without one", () => {
    expect(headline().find(".headline__caption").exists()).toBe(false);
    expect(headline("").find(".headline__caption").exists()).toBe(false);
  });
});

describe("the people chips", () => {
  const people: Person[] = [
    { id: "p1", name: LONG, sortOrder: 0 },
    { id: "p2", name: "Jo", sortOrder: 1 },
  ];

  it("puts each name in its own box and the whole name in the chip's title", () => {
    const w = mount(PeopleBar, { props: { people, selected: null, showUnassigned: true } });
    const chips = w.findAll(".pplbar__chip");
    expect(chips.map((c) => c.get(".pplbar__name").text())).toEqual(["Everyone", LONG, "Jo", "Unassigned"]);
    expect(chips[1]!.attributes("title")).toBe(LONG);
    expect(chips[2]!.attributes("title")).toBe("Jo");
    // the app's own short words carry no tooltip that would only repeat the chip
    expect(chips[0]!.attributes("title")).toBeUndefined();
    expect(chips[3]!.attributes("title")).toBeUndefined();
  });

  it("keeps the carry outside the name's box", () => {
    const w = mount(PeopleBar, {
      props: { people, selected: "p1", weights: { p1: "4.2 kg", [UNASSIGNED]: "1 kg" } },
    });
    const chip = w.findAll(".pplbar__chip")[1]!;
    expect(chip.get(".pplbar__name").text()).toBe(LONG);
    expect(chip.get(".pplbar__wt").text()).toBe("4.2 kg");
    expect(chip.get(".pplbar__name").element.contains(chip.get(".pplbar__wt").element)).toBe(false);
  });
});
