// ONE ALIGNMENT RULE. Anything with a title bar or rows reads from the left; a page that
// is one message and one way on is centred. The sign-in dialog broke the first half (a
// centred paragraph and last line under a title set left of its close button), and two
// pages broke the second (a shared list that isn't there and the sign-in link's page sat
// top-left while the 404 sat in the middle; the sign-in link's page has since become a
// dialog, accountAddress.nuxt.test.ts). Pinned by source: the rule is a handful of
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
    ["a gear link that's off", "app/pages/g/[code].vue"],
  ])("is what %s wears", (_name, path) => {
    expect(read(path)).toMatch(/<main[^>]*class="wrap page page--alone"/);
  });
});

describe("the sign-in column", () => {
  const view = read("app/components/AccountView.vue");

  it("reads from the left as a step of another page, under that page's own left edge", () => {
    const step = rule(view, ".acct--step .acct__empty");
    expect(step).toContain("text-align: start");
    // its controls still run the column's width, which is the column's own rule
    expect(rule(view, "\n.acct__empty")).toContain("align-items: stretch");
  });

  // The one dialog that is not left-aligned: it is the sign-in card, a centred title
  // under the mark (SignInHead.vue), so its lines centre under that and its controls still
  // run the card's width.
  it("centres its lines in the dialog, which is the sign-in card", () => {
    const card = rule(view, "\n.acct__empty");
    expect(card).toContain("text-align: center");
    // centred lines are balanced: `pretty` left two words alone under two full lines
    expect(card).toContain("text-wrap: balance");
    expect(rule(read("app/components/SignInHead.vue"), ".signin__body")).toContain("text-wrap: balance");
    const head = rule(read("app/components/SignInHead.vue"), ".signin__head");
    expect(head).toContain("align-items: center");
    expect(head).toContain("text-align: center");
    // and rounder than the other dialogs, to sit with the pills it holds
    expect(rule(read("app/components/SignInHead.vue"), ".dlg:has(> .signin__head)")).toContain(
      "border-radius: var(--radius-5)",
    );
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

  it("sets the explanation one group apart from the form", () => {
    expect(block(".acct__why")).toContain("margin-block-end: var(--space-2)");
  });

  it("sets a step's column one group from its host's heading, and the card's by the card's own gap", () => {
    expect(rule(view, ".acct--step .acct__empty")).toContain("margin-block-start: calc(-1 * var(--space-2))");
    expect(rule(view, "\n.acct__empty")).not.toContain("margin-block-start");
  });

  // The panel had a third mount, a page of its own, and carried that page's layout: a
  // modifier for "in a dialog", an <h1>, a column that centred and narrowed itself. The
  // page is the dialog now, and none of that is left to drift.
  it("carries nothing of the page it used to be", () => {
    expect(view).not.toContain("acct--modal");
    expect(view).not.toContain("inModal");
    expect(view).not.toContain("acct__head");
    expect(view).not.toMatch(/<h1/);
    expect(rule(view, "\n.acct__empty")).not.toContain("max-width");
  });
});
