// No hanging punctuation where a box clips.
//
// The root hangs a line's first and last bracket or quote outside the measure
// (reset.scss). Safari also leaves the hung mark out of the box's width, so in a field,
// or a one-line box that clips, the mark is drawn past the edge and cut off with no
// ellipsis: a list titled "PCT (Section J)" read "PCT (Section J", a folder "Kitchen
// (shared)" read "Kitchen (shared". Chromium and jsdom don't implement the property, so
// no other test can see it; this one checks the opt-outs are still in the compiled sheet.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as sass from "sass";

const ENTRY = fileURLToPath(new URL("../app/assets/styles/main.scss", import.meta.url));
const css = sass.compile(ENTRY, { style: "expanded" }).css;

/** The declarations of the first top-level rule whose selector list is exactly `selector`. */
function ruleBody(selector: string): string {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  expect(m, `no rule for ${selector} in the compiled sheet`).not.toBeNull();
  return m![1]!;
}

describe("hanging punctuation", () => {
  it("still hangs on the root, for prose", () => {
    expect(ruleBody(":root")).toMatch(/hanging-punctuation:\s*first last/);
  });

  it("never hangs inside a form control", () => {
    expect(ruleBody("input,\nselect,\ntextarea")).toMatch(/hanging-punctuation:\s*none/);
  });

  it.each([".t-clip", ".folder__name", ".item__carrier-name"])("never hangs in the one-line clip %s", (sel) => {
    expect(ruleBody(sel)).toMatch(/hanging-punctuation:\s*none/);
  });
});
