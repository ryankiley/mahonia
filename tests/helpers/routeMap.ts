// Mounting the route map for a suite: a short walk to draw, the ResizeObserver happy-dom
// lacks, and the wait for Leaflet. draw() is async (a nextTick, then `await
// import("leaflet")`, then the layers), so nothing is on the map when mount returns.

import { expect, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import RouteMap from "~/components/RouteMap.client.vue";
import { encodePolyline } from "~~/shared/polyline";

type Point = { lat: number; lon: number };

/** A walk north-east, about 1.5 km, so a day can cover part of it. */
export const WALK: Point[] = [
  { lat: 45.3736, lon: -121.696 },
  { lat: 45.378, lon: -121.69 },
  { lat: 45.382, lon: -121.684 },
  { lat: 45.386, lon: -121.678 },
];

type MapProps = {
  dayDistancesM?: number[];
  waypoints?: { id: string; kind: string; alongM: number; label?: string }[];
};

/**
 * Mount the map over `points` (the walk unless a suite needs its own), then wait until
 * `ready` finds what the suite is about: by default the first line drawn.
 */
export async function mountRouteMap(
  props: MapProps = {},
  {
    points = WALK,
    ready = (root: HTMLElement) => root.querySelector(".leaflet-overlay-pane path") !== null,
  }: { points?: Point[]; ready?: (root: HTMLElement) => boolean } = {},
): Promise<{ wrapper: VueWrapper; root: HTMLElement }> {
  // draw() watches the host's box; happy-dom has no ResizeObserver to hand it
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const wrapper: VueWrapper = mount(RouteMap, {
    props: { geometry: encodePolyline(points), dayDistancesM: [], ...props },
    attachTo: document.body,
  });
  const root = wrapper.element as HTMLElement;
  await vi.waitFor(() => expect(ready(root)).toBe(true), { interval: 25 });
  return { wrapper, root };
}
