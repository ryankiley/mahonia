// ONE ALIGNMENT RULE. Anything with a title bar or rows reads from the left; a page that
// is one message and one way on is centred. The sign-in dialog broke the first half (a
// centred paragraph and last line under a title set left of its close button), and two
// pages broke the second (a shared list that isn't there and the sign-in link's page sat
// top-left while the 404 sat in the middle). Pinned by source: the rule is a handful of
// declarations and a class, and jsdom lays nothing out.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");
// one rule's declarations, by its selector
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

describe("a page that is one message and one way on", () => {
  const main = read("app/assets/styles/main.scss");

  it("is centred both ways by one shared class", () => {
    const alone = rule(main, ".page--alone");
    expect(alone).toContain("place-items: center");
    expect(alone).toContain("text-align: center");
    // the height it centres in comes down from the layout's column
    expect(main).toContain(".shell__main:has(.page--alone)");
  });

  it("has equal air above and below, the footer's stand-off included", () => {
    // .page pads 24 over and 96 under, and the footer stands 48 off the content: the
    // message sat about 70px above the middle of the space between the two rules
    expect(rule(main, ".page--alone")).toContain("padding-block: var(--space-5)");
    expect(rule(main, ".shell:has(.page--alone) .foot")).toContain("margin-top: 0");
  });

  it.each([
    ["the 404", "app/error.vue"],
    ["a shared list that isn't there", "app/components/ReadonlyListView.vue"],
    ["the page a sign-in link lands on", "app/pages/auth/callback.vue"],
  ])("is what %s wears", (_name, path) => {
    expect(read(path)).toMatch(/<main[^>]*class="wrap page page--alone"/);
  });
});

describe("the sign-in column under something already set left", () => {
  const view = read("app/components/AccountView.vue");

  it("reads from the left in the dialog and as a step of another page", () => {
    const at = view.indexOf(".acct--step .acct__empty,\n.acct--modal .acct__empty {");
    expect(at).toBeGreaterThan(-1);
    const left = view.slice(at, view.indexOf("}", at));
    expect(left).toContain("text-align: start");
    expect(left).toContain("align-items: stretch");
  });

  it("no longer centres the line that switches between signing in and creating an account", () => {
    expect(view).not.toMatch(/\.acct__swap\s*\{[^}]*text-align:\s*center/);
  });
});

// TWO DISTANCES down the sign-in column: --space-3 inside a group, --space-5 between
// groups. It ran 22 / 28 / 12 / 16 / 24 down the dialog. The column's gap is --space-4,
// so each group edge carries the --space-2 that makes it --space-5.
describe("the sign-in column's spacing", () => {
  const view = read("app/components/AccountView.vue");
  const block = (selector: string) => {
    const at = view.lastIndexOf(`\n${selector} {`);
    return at < 0 ? "" : view.slice(at, view.indexOf("}", at));
  };

  it("sets the explanation and the switch line one group apart from the form", () => {
    expect(block(".acct__why")).toContain("margin-block-end: var(--space-2)");
    expect(block(".acct__swap")).toContain("margin-block-start: var(--space-2)");
  });

  it("pulls the dialog's column up to its title", () => {
    expect(view).toMatch(/\.acct--modal \.acct__empty \{\s*margin-block-start: calc\(-1 \* var\(--space-2\)\);/);
  });
});
