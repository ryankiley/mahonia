// The keyboard flag (app/plugins/inputModality.client.ts) that makes keyboard-initiated
// motion instant: atoms/modality.scss keys every duration off it, and motionIsInstant()
// is what script asks before starting a Web Animation or timing a wait. A nuxt test
// because it is the PLUGIN under test — registered by the app boot, listening on window.
import { afterEach, describe, expect, it } from "vitest";
import { keyboardModality, motionIsInstant } from "~/plugins/inputModality.client";

const root = document.documentElement;
afterEach(() => {
  delete root.dataset.input;
});

const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
const pointer = (type: "pointerdown" | "pointermove") => window.dispatchEvent(new Event(type));

describe("input modality", () => {
  it("sets the flag on a key and clears it when the pointer moves or presses", () => {
    key("ArrowDown");
    expect(root.dataset.input).toBe("keyboard");
    expect(keyboardModality()).toBe(true);
    expect(motionIsInstant()).toBe(true);
    pointer("pointermove");
    expect(root.dataset.input).toBeUndefined();
    expect(motionIsInstant()).toBe(false);
    key("Enter");
    pointer("pointerdown");
    expect(root.dataset.input).toBeUndefined();
  });

  it("doesn't take a bare modifier for keyboard use (half of a shift- or ⌘-click)", () => {
    for (const k of ["Shift", "Meta", "Control", "Alt"]) key(k);
    expect(root.dataset.input).toBeUndefined();
    key("k"); // ⌘K is a chord, and a chord is the keyboard
    expect(root.dataset.input).toBe("keyboard");
  });
});
