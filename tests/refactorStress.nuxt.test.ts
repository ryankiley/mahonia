// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, effectScope, nextTick, ref } from "vue";
import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { useGearEditorView } from "~/composables/useGearEditorView";
import { useTripLoadModel } from "~/composables/useTripLoadModel";
import { useTrailPlanRoute } from "~/composables/useTrailPlanRoute";
import { useRouteMapGeometry } from "~/composables/useRouteMapGeometry";
import { applyOps, MAX_DAYS, MAX_FOLDERS, MAX_ITEMS, MAX_PEOPLE, MAX_WAYPOINTS, type ItemPatch } from "~~/shared/ops";
import { encodePolyline, MAX_ROUTE_POINTS } from "~~/shared/polyline";
import { computeTotals } from "~~/shared/weights";
import { UNASSIGNED } from "~~/shared/people";
import type { Item, ListSnapshot } from "~~/shared/types";
import { blankList } from "./helpers/list";

const snapshot = ref<ListSnapshot>(blankList());
mockNuxtImport("useGearList", () => () => ({
  snapshot,
  totals: computed(() => computeTotals(snapshot.value)),
  updateItem: (id: string, patch: ItemPatch) => applyOps(snapshot.value, [{ t: "updateItem", id, patch }]),
}));

let scope = effectScope();
beforeEach(() => {
  scope = effectScope();
  usePersonFilter().clear();
  useEditorMode().mode.value = "edit";
});
afterEach(() => {
  scope.stop();
  usePersonFilter().clear();
});

function largeList(): ListSnapshot {
  return blankList({
    shareCode: "STRESS01",
    folders: Array.from({ length: MAX_FOLDERS }, (_, i) => ({
      id: `f${i}`, name: `Folder ${i}`, sortOrder: i, defaultClassification: "base",
    })),
    people: Array.from({ length: MAX_PEOPLE }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, sortOrder: i })),
    items: Array.from({ length: MAX_ITEMS }, (_, i): Item => ({
      id: `i${i}`, folderId: `f${Math.floor(i / 20)}`, sortOrder: i,
      parentId: i % 20 >= 1 && i % 20 <= 4 ? `i${i - i % 20}` : null,
      personId: i % 20 >= 1 && i % 20 <= 4 || i % 20 === 19 ? undefined : `p${i % MAX_PEOPLE}`,
      name: i % 20 === 1 ? "Water" : `Item ${i}`,
      unitWeightMg: i % 20 === 0 ? 0 : i % 20 === 1 ? 1_000_000 : 10_000 + i,
      qty: i % 20 === 0 ? 1 : 1 + i % 4,
      classification: i % 20 === 1 || i % 3 === 1 ? "consumable" : i % 3 === 2 ? "worn" : "base",
      packed: i % 2 === 0,
    })),
    days: Array.from({ length: MAX_DAYS }, (_, i) => ({ id: `d${i}`, sortOrder: i, distanceM: 1_000 })),
  });
}

// Deliberately arithmetic, not computeTotals/filterItemsForPerson: a wiring bug must
// not be able to agree with itself on both sides of the assertion.
function expectedRows(selection: string | null) {
  const byId = new Map(snapshot.value.items.map((item) => [item.id, item]));
  return snapshot.value.items.filter((item) => {
    if (!selection) return true;
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    const person = item.personId ?? parent?.personId;
    return selection === UNASSIGNED ? !person : person === selection;
  });
}
const totalMg = (items: Item[]) => items.reduce((sum, item) => sum + item.unitWeightMg * item.qty, 0);

describe("extracted models under sustained edits", () => {
  it("keeps max-size grouping, person totals, packing and 60-day loads live over 300 edits", async () => {
    snapshot.value = largeList();
    const editor = scope.run(() => useGearEditorView({ flash: vi.fn(), askConfirm: async () => true }))!;
    const load = scope.run(() => useTripLoadModel({
      snapshot, totals: computed(() => computeTotals(snapshot.value)), days: computed(() => snapshot.value.days ?? []),
    }))!;
    expect(editor.sortedFolders.value).toHaveLength(MAX_FOLDERS);
    expect(editor.childrenByParent.value.size).toBe(50);
    expect([...editor.itemsByFolder.value.values()].flat()).toHaveLength(800);
    expect([...editor.childrenByParent.value.values()].flat()).toHaveLength(200);

    for (let n = 0; n < 300; n++) {
      const item = snapshot.value.items[(n * 37) % MAX_ITEMS]!;
      applyOps(snapshot.value, [{ t: "updateItem", id: item.id, patch: {
        qty: 1 + n % 9, packed: n % 3 === 0,
        ...(n % 5 === 0 ? { personId: `p${n % MAX_PEOPLE}` } : {}),
      } }]);
      const selection = n % 14 === 12 ? UNASSIGNED : n % 14 === 13 ? null : `p${n % 14}`;
      editor.personFilter.selected.value = selection;
      editor.mode.value = (["edit", "pack", "plan"] as const)[n % 3]!;
      await nextTick();

      const rows = expectedRows(selection);
      expect(editor.filteredItems.value.map((row) => row.id)).toEqual(rows.map((row) => row.id));
      expect(editor.view.value.totals?.totalMg).toBe(totalMg(rows));
      const countable = rows.filter((row) => row.unitWeightMg > 0);
      expect(editor.packProgress.value).toEqual({ total: countable.length, done: countable.filter((row) => row.packed).length });
      expect(editor.packed.value).toBe(n % 3 === 1);
      const carried = snapshot.value.items.filter((row) => row.classification !== "worn");
      const food = carried.filter((row) => row.classification === "consumable" && row.name !== "Water");
      expect(load.packMg.value).toHaveLength(MAX_DAYS);
      expect(load.packMg.value[0]).toBe(Math.round(totalMg(carried) - totalMg(food) / MAX_DAYS * 0.5));
      expect(load.packMg.value.at(-1)).toBe(Math.round(totalMg(carried) - totalMg(food) / MAX_DAYS * (MAX_DAYS - 0.5)));
    }

    editor.personFilter.selected.value = "p0";
    const selectedIds = new Set(expectedRows("p0").map((row) => row.id));
    const untouched = new Map(snapshot.value.items.filter((row) => !selectedIds.has(row.id)).map((row) => [row.id, row.packed]));
    await editor.clearChecks();
    expect(editor.packProgress.value.done).toBe(0);
    for (const [id, packed] of untouched) expect(snapshot.value.items.find((row) => row.id === id)?.packed).toBe(packed);
  });

  it("drops a vanished person selection and tears down its watcher on unmount", async () => {
    snapshot.value = largeList();
    const flash = vi.fn();
    const editor = scope.run(() => useGearEditorView({ flash, askConfirm: async () => true }))!;
    editor.personFilter.selected.value = "p0";
    applyOps(snapshot.value, [{ t: "removePerson", id: "p0" }]);
    await nextTick();
    expect(editor.personFilter.selected.value).toBeNull();
    expect(editor.view.value.totals?.totalMg).toBe(totalMg(snapshot.value.items));
    scope.stop();
    editor.personFilter.selected.value = "p1";
    snapshot.value = blankList({ shareCode: "OTHER" });
    await nextTick();
    expect(editor.personFilter.selected.value).toBe("p1");
    expect(flash).not.toHaveBeenCalled();
  });

  it("conserves distance and pin ownership through 1,000 legal drags with max days, pins and geometry", () => {
    snapshot.value = largeList();
    snapshot.value.routeGeometry = encodePolyline(Array.from({ length: MAX_ROUTE_POINTS }, (_, i) => ({ lat: 45 + i / 500, lon: -121 })));
    snapshot.value.trailDistanceM = 120_000;
    snapshot.value.days!.forEach((day, i) => { day.distanceM = i % 3 === 1 ? 0 : 1_000; });
    snapshot.value.waypoints = Array.from({ length: MAX_WAYPOINTS }, (_, i) => ({ id: `w${i}`, kind: "water", alongM: i * 500 }));
    const days = computed(() => snapshot.value.days!);
    const plan = scope.run(() => useTrailPlanRoute({ snapshot, stored: days, days, controller: {
      ensureRouteEnds: vi.fn(),
      updateDay: (id, patch) => { applyOps(snapshot.value, [{ t: "updateDay", id, patch }]); },
    } }))!;
    const geometry = useRouteMapGeometry({ geometry: computed(() => snapshot.value.routeGeometry!), dayDistancesM: plan.dayDistancesM });
    const originalTotal = plan.restFromM.value;
    for (let n = 0; n < 1_000; n++) {
      const candidates = geometry.boundaries.value.filter((boundary) => boundary.index < MAX_DAYS - 1);
      const boundary = candidates[n * 17 % candidates.length]!;
      const fraction = [0, 1, 0.37, 0.63][n % 4]!;
      const alongM = Math.round(boundary.minM + (boundary.maxM - boundary.minM) * fraction);
      plan.onBoundary({ index: boundary.index, alongM });
      expect(plan.restFromM.value).toBe(originalTotal);
      expect(plan.dayDistancesM.value.every((distance, i) => i % 3 === 1 ? distance === 0 : distance >= 200)).toBe(true);
      const { byDay, rest } = plan.grouped.value;
      expect(new Set([...byDay.flat(), ...rest].map((pin) => pin.id)).size).toBe(MAX_WAYPOINTS);
      expect(byDay.flat().length + rest.length).toBe(MAX_WAYPOINTS);
      byDay.forEach((pins, i) => {
        const range = plan.ranges.value[i]!;
        for (const pin of pins) {
          expect(pin.alongM).toBeGreaterThanOrEqual(range.fromM);
          expect(pin.alongM <= range.toM && (pin.alongM < range.toM || pin.alongM === originalTotal)).toBe(true);
        }
      });
      if (n % 20 === 0) {
        const legs = geometry.dayLegs.value;
        expect(legs).toHaveLength(40);
        for (let i = 1; i < legs.length; i++) expect(legs[i]!.points[0]).toEqual(legs[i - 1]!.points.at(-1));
      }
    }
    snapshot.value.routeGeometry = "";
    snapshot.value.days = [];
    snapshot.value.trailDistanceM = 0;
    expect(geometry.dayLegs.value).toEqual([]);
    expect(geometry.boundaries.value).toEqual([]);
    expect(plan.finishDayIndex.value).toBe(-1);
    expect(plan.hasRest.value).toBe(false);
  });
});
