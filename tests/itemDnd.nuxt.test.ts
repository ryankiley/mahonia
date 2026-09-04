// @vitest-environment nuxt
//
// The item drag's DROP-TARGET math — which slot, and which nesting level, the
// gesture is aiming at. The lifecycle underneath it (capture, listeners, cancels)
// is pointerDrag.nuxt.test.ts's; what's pinned here is the one decision this file
// owns: whether a drag reads as a vertical reorder or a horizontal re-nest.
//
// The regression that prompted these: the re-nest threshold was a bare 24px of
// horizontal travel from the pickup point, re-tested on every pointermove for the
// whole gesture. So reordering a row WITHIN a group — the ordinary vertical drag —
// popped it out to top level as soon as the pointer had wandered 24px left of where
// it started, which any drag of a few rows does, and which a thumb dragging down
// from the grip at the row's right edge does every time.
//
// The rule that replaced it: a move re-nests only while it still READS as horizontal
// — across-travel over the threshold AND out-running the down-travel — re-read every
// move, never latched. The cases below are ordered to pin that literally, because the
// obvious latched variant passes almost all of them: the ones that actually
// discriminate are "the drift LEADS the descent" (a latch arms on the first sample
// and never lets go) and "lets the row back into the group once the drag turns
// vertical" (a latch holds the escape instead).
//
// happy-dom lays nothing out, so every rect below is stubbed, the same way
// pointerDrag.nuxt.test.ts stubs elementFromPoint: the decision under test is ABOUT
// those readings, so faking them is faking the input, not the logic. What's asserted
// is `drop` — the target the release would commit, and the thing every row's
// indicator hangs off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import type { Item } from "~~/shared/types";

// The controller is read for one thing on this path — the dragged row's own folder
// and parent — so it's stubbed to that, rather than dragging the sync engine in.
const snapshot = ref<{ items: Item[] } | null>(null);
mockNuxtImport("useGearList", () => () => ({ snapshot }));

const FOLDER = "f1";
const item = (over: Partial<Item> & { id: string }): Item => ({
  folderId: FOLDER,
  parentId: null,
  name: over.id,
  unitWeightMg: 0,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

// One folder holding: group `pot` (children `lid`, `spoon`), then top-level `tent`.
// Vertical bands, matching what the browser lays out — a group's wrap contains its
// children, so `pot` spans the whole block.
const BANDS: Record<string, [number, number]> = {
  pot: [100, 220],
  lid: [140, 180],
  spoon: [180, 220],
  tent: [220, 260],
};

function stubRect(el: Element, top: number, bottom: number) {
  el.getBoundingClientRect = (() => ({
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 400,
    width: 400,
  })) as never;
}

function buildDom() {
  document.body.innerHTML = `
    <div class="editor__body">
      <section class="folder" data-folder="${FOLDER}">
        <div class="item-wrap" data-item-id="pot">
          <button class="grip"></button>
          <div class="item-nest">
            <div class="item-wrap" data-item-id="lid" data-parent="pot"><button class="grip"></button></div>
            <div class="item-wrap" data-item-id="spoon" data-parent="pot"><button class="grip"></button></div>
          </div>
        </div>
        <div class="item-wrap" data-item-id="tent"><button class="grip"></button></div>
      </section>
    </div>`;
  for (const [id, [top, bottom]] of Object.entries(BANDS))
    stubRect(document.querySelector(`[data-item-id="${id}"]`)!, top, bottom);
  stubRect(document.querySelector("[data-folder]")!, 80, 300);
  stubRect(document.querySelector(".editor__body")!, 0, 600);
}

beforeEach(() => {
  snapshot.value = {
    items: [
      item({ id: "pot", name: "Cook kit", sortOrder: 0 }),
      item({ id: "lid", parentId: "pot", unitWeightMg: 30_000, sortOrder: 0 }),
      item({ id: "spoon", parentId: "pot", unitWeightMg: 10_000, sortOrder: 1 }),
      item({ id: "tent", unitWeightMg: 900_000, sortOrder: 1 }),
    ],
  };
  buildDom();
  usePersonFilter().clear();
  // the pointer is over the folder for every case here; nesting is decided by the
  // gesture, not by which element the cursor happens to land on
  document.elementFromPoint = (() =>
    document.querySelector("[data-folder]")) as typeof document.elementFromPoint;
  document.documentElement.setPointerCapture = vi.fn();
  document.documentElement.releasePointerCapture = vi.fn();
});
afterEach(() => {
  useItemDnd().reset();
  document.body.innerHTML = "";
});

/** Grab `id` by its grip at (200, its band's middle) and walk the pointer through
 *  `path` — offsets from that pickup point. Hands back the resulting drop target. */
function drag(id: string, path: [number, number][]) {
  const dnd = useItemDnd();
  const [top, bottom] = BANDS[id]!;
  const x0 = 200;
  const y0 = (top + bottom) / 2;
  const grip = document.querySelector<HTMLElement>(`[data-item-id="${id}"] .grip`)!;
  grip.addEventListener("pointerdown", (e) => dnd.start(id, e as PointerEvent));
  grip.dispatchEvent(
    new PointerEvent("pointerdown", { pointerId: 1, clientX: x0, clientY: y0, bubbles: true }),
  );
  for (const [dx, dy] of path)
    window.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 1, clientX: x0 + dx, clientY: y0 + dy, bubbles: true }),
    );
  return dnd.drop.value;
}

describe("reordering inside a group", () => {
  // The regression. 30px of leftward drift over a 60px vertical drag is what a hand
  // does; it is not a request to un-nest.
  it("stays nested through a vertical drag that drifts sideways", () => {
    const drop = drag("lid", [
      [-4, 12],
      [-14, 30],
      [-24, 46],
      [-30, 60],
    ]);
    expect(drop).toMatchObject({ folderId: FOLDER, parentId: "pot", beforeId: null });
  });

  // The shape that defeats a latched reading of the same rule, and the one a thumb
  // rolling off a right-edge grip actually makes: the sideways component ARRIVES
  // first and then the descent out-runs it. Same total travel as the case above,
  // only reordered — which is exactly why order must not decide the outcome.
  it("stays nested when the sideways drift leads the descent", () => {
    const drop = drag("lid", [
      [-26, 6],
      [-30, 40],
      [-32, 100],
    ]);
    expect(drop).toMatchObject({ folderId: FOLDER, parentId: "pot", beforeId: null });
  });

  it("moves a child above its sibling on a straight upward drag", () => {
    expect(drag("spoon", [[0, -20], [0, -45]])).toMatchObject({ parentId: "pot", beforeId: "lid" });
  });

  it("appends a child below its sibling on a straight downward drag", () => {
    expect(drag("lid", [[0, 20], [0, 60]])).toMatchObject({ parentId: "pot", beforeId: null });
  });

  // Dragging a nested row far past the group is still a reorder within it — leaving
  // the group is the sideways gesture below, not a vertical one.
  it("keeps a child in its group even when dragged below the folder's last row", () => {
    expect(drag("lid", [[0, 40], [0, 120]])).toMatchObject({ parentId: "pot" });
  });
});

describe("the sideways gesture", () => {
  it("pulls a child out to top level on a deliberate leftward drag", () => {
    const drop = drag("lid", [[-12, 2], [-40, 4]]);
    expect(drop).toMatchObject({ folderId: FOLDER, parentId: null });
  });

  // The accepted cost of reading it live. Pulling a row out and then carrying it a
  // long way down is TWO gestures, not one: once the descent out-runs the 40px of
  // lead, the move stops reading as horizontal and the row is back in its group.
  // This is not a wart to route around — it is the same test that makes the case
  // above work, since "pull out then carry down" and "drift then descend" are the
  // same cumulative shape and nothing can tell them apart after the fact.
  it("lets the row back into the group once the descent out-runs the pull", () => {
    const drop = drag("lid", [
      [-40, 4], // reads as horizontal — the row is out
      [-40, 60], // …and now it doesn't
      [-40, 100],
    ]);
    expect(drop).toMatchObject({ parentId: "pot" });
  });

  // …and it is still one gesture whenever the lead survives to the release, which is
  // what the indicator is showing the whole time.
  it("stays out while the pull keeps its lead over the descent", () => {
    expect(drag("lid", [[-40, 4], [-90, 60], [-140, 100]])).toMatchObject({ parentId: null });
  });

  it("comes back into the group when the pointer returns inside the threshold", () => {
    const drop = drag("lid", [[-40, 4], [-8, 10]]);
    expect(drop).toMatchObject({ parentId: "pot" });
  });

  it("nests a top-level row under the row above on a rightward drag", () => {
    expect(drag("tent", [[12, 0], [40, 2]])).toMatchObject({ parentId: "pot" });
  });

  // The mirror of the regression: rightward drift on a vertical drag is not a
  // request to nest either.
  it("does not nest a top-level row on a vertical drag that drifts right", () => {
    expect(drag("tent", [[10, -20], [26, -50], [30, -60]])).toMatchObject({ parentId: null });
  });
});

// A filtered view is a way of LOOKING at the list, so it reorders but does not
// restructure: nesting in would make the row inherit a carrier and vanish out of the
// view being worked in, and un-nesting drops the carrier it had inherited for the
// same disappearing act — plus it can take an emptied group with it. The indent menu
// stands down under a filter in CSS; these are the same rule for the drag, and the
// escape half of it had no guard at all.
describe("under a person filter", () => {
  beforeEach(() => {
    usePersonFilter().selected.value = "sam";
  });

  it("keeps a nested row in its group on a deliberate leftward pull", () => {
    expect(drag("lid", [[-12, 2], [-40, 4]])).toMatchObject({ parentId: "pot" });
  });

  it("does not nest a top-level row on a deliberate rightward push", () => {
    expect(drag("tent", [[12, 0], [40, 2]])).toMatchObject({ parentId: null });
  });
});
