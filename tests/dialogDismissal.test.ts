// A DIALOG LEAVES THE WAY A MENU DOES. The menus' exit was reworked so they stop
// blinking out: it leaves from rest, on the step spring at 0.6 of its beat, moving a
// short way back toward where it came from with no scale. The dialogs still left on the
// fade spring, which is launched, so a dismissed dialog was gone in a frame or two.
// Pinned by source: a transition is a few declarations, and jsdom runs none of it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};
const STEP = "calc(var(--spring-step-dur) * 0.6) var(--spring-step)";

describe("a dialog's dismissal", () => {
  const dialog = read("app/assets/styles/atoms/dialog.scss");
  const menus = read("app/assets/styles/atoms/controls.scss");

  it("is on the menus' spring and beat, for the scrim and the card", () => {
    expect(rule(menus, ".menu-leave-active")).toContain(`opacity ${STEP}`);
    expect(rule(dialog, ".ovl-leave-active")).toContain(`opacity ${STEP}`);
    const card = rule(dialog, ".ovl-leave-active .dlg");
    expect(card).toContain(`transform ${STEP}`);
    expect(card).toContain(`opacity ${STEP}`);
  });

  it("sends the card back the way it came, half as far, with no scale", () => {
    expect(rule(dialog, ".ovl-enter-from .dlg")).toContain("transform: translateY(12px)");
    const leaving = rule(dialog, ".ovl-leave-to .dlg");
    expect(leaving).toContain("transform: translateY(6px)");
    expect(leaving).not.toContain("scale");
  });
});
