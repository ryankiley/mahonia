// A route file is read asynchronously, through the editor controller — which is a
// singleton. So "which list is open" can change while a file is being read, and a
// late parse must not land its route on whatever list came next; and the pin offer
// the file leaves behind is only good for the list it was made on.
import { describe, expect, it, vi } from "vitest";
import { ref, shallowRef, nextTick } from "vue";
import { useGpxImport } from "~/composables/useGpxImport";
import { MAX_WAYPOINTS } from "~~/shared/ops";
import type { ListSnapshot } from "~~/shared/types";
import { snapshotFor } from "./helpers/list";

const snapshot = (title: string, overrides: Partial<ListSnapshot> = {}): ListSnapshot =>
  snapshotFor({ shareCode: "SNAPCODE0001", slug: "test-list", title, ...overrides });

const track = `<?xml version="1.0"?>
<gpx version="1.1"><trk><trkseg>
  <trkpt lat="45.5000" lon="-121.7000"><ele>1000</ele></trkpt>
  <trkpt lat="45.5100" lon="-121.6900"><ele>1100</ele></trkpt>
</trkseg></trk></gpx>`;

// more marked places than a list can hold, spread along the track so none dedupe
const trackWithPins = track.replace(
  "</trkseg></trk>",
  `</trkseg></trk>${Array.from(
    { length: MAX_WAYPOINTS + 50 },
    (_, i) => `<wpt lat="${(45.5 + (i / (MAX_WAYPOINTS + 50)) * 0.01).toFixed(6)}" lon="${(-121.7 + (i / (MAX_WAYPOINTS + 50)) * 0.01).toFixed(6)}"><name>Place ${i}</name></wpt>`,
  ).join("")}`,
);

// the input only needs this much File; holding `text()` keeps a real parse in flight
function fileOf(text: string, hold?: (release: (t: string) => void) => void) {
  const bytes = new TextEncoder().encode(text);
  const file = {
    size: bytes.length,
    slice: () => ({ arrayBuffer: async () => bytes.buffer }),
    arrayBuffer: async () => bytes.buffer,
    text: () => (hold ? new Promise<string>((resolve) => hold(resolve)) : Promise.resolve(text)),
  };
  const input = document.createElement("input");
  Object.defineProperty(input, "files", { value: [file] });
  return { target: input } as unknown as Event;
}

describe("a route file read that outlives its list", () => {
  it("drops a parse that finishes after the controller has loaded another list", async () => {
    const epochRef = shallowRef(1);
    const current = ref<ListSnapshot | null>(snapshot("First list"));
    const setMeta = vi.fn();
    const importer = useGpxImport({
      epochRef,
      snapshot: current,
      setMeta,
      addWaypoint: vi.fn(),
      updateWaypoint: vi.fn(),
    });

    let release: ((t: string) => void) | undefined;
    const reading = importer.onGpx(fileOf(track, (r) => (release = r)));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(importer.gpxBusy.value).toBe(true);

    // the same controller loads a second list before the browser finishes the read
    epochRef.value++;
    current.value = snapshot("Second list");
    release!(track);
    await reading;

    expect(setMeta).not.toHaveBeenCalled();
    expect(importer.pending.value).toBeNull();
    expect(importer.gpxBusy.value).toBe(false);
  });

  it("clears a held offer, and takes no yes for it, once the list changes", async () => {
    const epochRef = shallowRef(1);
    const current = ref<ListSnapshot | null>(snapshot("A list"));
    const addWaypoint = vi.fn();
    const importer = useGpxImport({
      epochRef,
      snapshot: current,
      setMeta: vi.fn(),
      addWaypoint,
      updateWaypoint: vi.fn(),
    });
    await importer.onGpx(fileOf(trackWithPins));
    expect(importer.pending.value?.pins.length).toBeGreaterThan(0);

    // `dispose(); startDraft()` swaps the list in one tick without unmounting the head
    epochRef.value = 2;
    await nextTick();
    expect(importer.pending.value).toBeNull();

    // and an offer captured before the swap is no answer for the new list either
    importer.pending.value = { geometry: "", pins: [], kindOf: () => "landmark", epoch: 1 };
    await importer.confirmPins();
    expect(addWaypoint).not.toHaveBeenCalled();
  });
});

describe("the pin offer is bounded by the room the list has", () => {
  const routeEnds = [
    { id: "wp-start", kind: "trailhead" as const, alongM: 0 },
    { id: "wp-end", kind: "end" as const, alongM: 1_000 },
  ];

  it("offers only as many pins as fit after the route's own ends", async () => {
    const current = ref<ListSnapshot | null>(snapshot("Empty list"));
    const importer = useGpxImport({
      epochRef: shallowRef(1),
      snapshot: current,
      // the reducer seeds the ends when the geometry lands; the offer must count them
      setMeta: vi.fn(() => { current.value!.waypoints = routeEnds; }),
      addWaypoint: vi.fn(),
      updateWaypoint: vi.fn(),
    });
    await importer.onGpx(fileOf(trackWithPins));
    expect(importer.pending.value?.pins).toHaveLength(MAX_WAYPOINTS - routeEnds.length);
  });

  it("stops at the cap if the list filled while the offer stood", async () => {
    const current = ref<ListSnapshot | null>(snapshot("Empty list"));
    const addWaypoint = vi.fn();
    const importer = useGpxImport({
      epochRef: shallowRef(1),
      snapshot: current,
      setMeta: vi.fn(() => { current.value!.waypoints = routeEnds; }),
      addWaypoint,
      updateWaypoint: vi.fn(),
    });
    await importer.onGpx(fileOf(trackWithPins));
    // a collaborator takes every slot while the question is on screen: a yes now
    // must not queue a single op the reducer would drop
    current.value!.waypoints = Array.from({ length: MAX_WAYPOINTS }, (_, i) => ({
      id: `waypoint-${i}`,
      kind: "landmark" as const,
      alongM: i * 10,
    }));
    await importer.confirmPins();
    expect(addWaypoint).not.toHaveBeenCalled();
  });
});

// A list can have a distance before it has a route: the one typed off a sign. The file's
// measurement went over it without a word (18 mi became 8.2 in the review that found it).
describe("a typed distance the file's own takes the place of", () => {
  // a list whose setMeta lands, as the reducer's does
  function importerOn(start: Partial<ListSnapshot>) {
    const current = ref<ListSnapshot | null>(snapshot("Trip", start));
    const importer = useGpxImport({
      epochRef: shallowRef(1),
      snapshot: current,
      setMeta: (patch) => {
        current.value = { ...current.value!, ...patch } as ListSnapshot;
      },
      addWaypoint: vi.fn(),
      updateWaypoint: vi.fn(),
    });
    return { current, importer };
  }
  const TYPED_M = 28_968; // 18 mi

  it("says so, and puts the typed figure back when asked", async () => {
    const { current, importer } = importerOn({ trailDistanceM: TYPED_M });
    await importer.onGpx(fileOf(track));
    const fileM = current.value!.trailDistanceM!;
    expect(fileM).not.toBe(TYPED_M);
    expect(importer.replaced.value).toMatchObject({ wasM: TYPED_M, nowM: fileM });

    importer.keepTyped();
    expect(current.value!.trailDistanceM).toBe(TYPED_M);
    expect(importer.replaced.value).toBeNull();
    // the route itself stays: only the figure went back
    expect(current.value!.routeGeometry).toBeTruthy();
  });

  it("says nothing when there was no typed distance to lose", async () => {
    // none at all
    const blank = importerOn({});
    await blank.importer.onGpx(fileOf(track));
    expect(blank.importer.replaced.value).toBeNull();

    // one a file put there: replacing a file changes the distance as a matter of course
    const second = importerOn({});
    await second.importer.onGpx(fileOf(track));
    second.current.value = { ...second.current.value!, trailDistanceM: TYPED_M };
    await second.importer.onGpx(fileOf(track));
    expect(second.importer.replaced.value).toBeNull();

    // the same distance, give or take a track's noise
    const measured = blank.current.value!.trailDistanceM!;
    const close = importerOn({ trailDistanceM: measured + 50 });
    await close.importer.onGpx(fileOf(track));
    expect(close.importer.replaced.value).toBeNull();
  });

  it("drops the notice once the distance is typed over", async () => {
    const { current, importer } = importerOn({ trailDistanceM: TYPED_M });
    await importer.onGpx(fileOf(track));
    expect(importer.replaced.value).not.toBeNull();
    current.value = { ...current.value!, trailDistanceM: 5_000 };
    await nextTick();
    expect(importer.replaced.value).toBeNull();
  });
});
