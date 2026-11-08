// The folders' entrance plays ONCE per list opened (GearEditor's foldersRef watch +
// playOnce). The animation is switched on by a class on the container, and the class is
// what this asserts: on for the run, off for good once the last folder lands — off on
// that folder's animationend, or on the backstop when nothing ever ends (a hidden tab,
// a last folder a filter hides, a list opened in Trip). While it sat on every folder
// for good, a reorder, a filter cleared or a return from Trip replayed it, blanking the
// moved folder through its delay. A nuxt test because the helper lives in the editor's
// SFC, which only the Nuxt project compiles.
import { afterEach, describe, expect, it, vi } from "vitest";
import { playOnce } from "~/components/GearEditor.client.vue";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const folders = (n: number) => {
  const el = document.createElement("div");
  for (let i = 0; i < n; i++) el.append(document.createElement("section"));
  document.body.append(el);
  return el;
};
const landed = (el: Element) => el.dispatchEvent(new Event("animationend", { bubbles: true }));

describe("the folders' entrance", () => {
  it("is on for the run and off once the last folder lands", () => {
    const el = folders(3);
    playOnce(el, "is-opening", 1_000);
    expect(el.classList.contains("is-opening")).toBe(true);
    landed(el.children[0]!); // an early folder landing is not the end of the run
    expect(el.classList.contains("is-opening")).toBe(true);
    landed(el.lastElementChild!);
    expect(el.classList.contains("is-opening")).toBe(false);
  });

  it("ignores an animation ending deeper inside a folder", () => {
    const el = folders(2);
    const row = el.lastElementChild!.appendChild(document.createElement("div"));
    playOnce(el, "is-opening", 1_000);
    landed(row);
    expect(el.classList.contains("is-opening")).toBe(true);
  });

  it("comes off on the backstop when no folder ever reports landing", () => {
    vi.useFakeTimers();
    const el = folders(2);
    playOnce(el, "is-opening", 1_000);
    vi.advanceTimersByTime(999);
    expect(el.classList.contains("is-opening")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains("is-opening")).toBe(false);
  });

  it("stays off after the run: a reordered or added folder doesn't bring it back", () => {
    const el = folders(3);
    playOnce(el, "is-opening", 1_000);
    landed(el.lastElementChild!);
    el.insertBefore(el.lastElementChild!, el.firstElementChild); // a reorder: Vue moves the node
    el.append(document.createElement("section")); // a new folder
    landed(el.lastElementChild!);
    expect(el.classList.contains("is-opening")).toBe(false);
  });
});
