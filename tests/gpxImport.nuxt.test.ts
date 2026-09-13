// @vitest-environment nuxt
//
// A GPX file is read asynchronously, while the editor controller is a singleton.
// That makes list navigation during a file read a real ownership boundary: a late
// parser result must not write the route into whatever list was opened next.
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useGpxImport } from "~/composables/useGpxImport";
import { MAX_FILE_PINS } from "~~/shared/gpx";
import type { ListSnapshot } from "~~/shared/types";

const snapshot = (title: string, overrides: Partial<ListSnapshot> = {}): ListSnapshot => ({
  shareCode: "SNAPCODE0001",
  slug: "test-list",
  title,
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version: 1,
  isPublic: false,
  ...overrides,
});

const track = `<?xml version="1.0"?>
<gpx version="1.1"><trk><trkseg>
  <trkpt lat="45.5000" lon="-121.7000"><ele>1000</ele></trkpt>
  <trkpt lat="45.5100" lon="-121.6900"><ele>1100</ele></trkpt>
</trkseg></trk></gpx>`;

const trackWithPins = track.replace(
  "</trkseg></trk>",
  `</trkseg></trk>${Array.from(
    { length: MAX_FILE_PINS },
    (_, i) => `<wpt lat="45.50${i % 10}" lon="-121.69${i % 10}"><name>Place ${i}</name></wpt>`,
  ).join("")}`,
);

describe("a GPX import that outlives its list", () => {
  it("does not apply a late route parse to the list opened afterward", async () => {
    let epoch = 1;
    const current = ref<ListSnapshot | null>(snapshot("First list"));
    const setMeta = vi.fn();
    const target = {
      get epoch() {
        return epoch;
      },
      snapshot: current,
      setMeta,
      addWaypoint: vi.fn(),
      updateWaypoint: vi.fn(),
    };
    const importer = useGpxImport(current, target);

    let releaseText: ((text: string) => void) | undefined;
    const bytes = new TextEncoder().encode(track);
    // The input only needs this small File surface. Holding `text()` gives the
    // test a real parse in flight without relying on a browser file picker.
    const file = {
      size: bytes.length,
      slice: () => ({ arrayBuffer: async () => bytes.buffer }),
      arrayBuffer: async () => bytes.buffer,
      text: () => new Promise<string>((resolve) => (releaseText = resolve)),
    };
    const input = document.createElement("input");
    Object.defineProperty(input, "files", { value: [file] });

    const reading = importer.onGpx({ target: input } as unknown as Event);
    await vi.waitFor(() => expect(releaseText).toBeTypeOf("function"));

    // The same controller has now loaded a second list before the browser finishes
    // reading the first file.
    epoch++;
    current.value = snapshot("Second list");
    releaseText!(track);
    await reading;

    expect(setMeta).not.toHaveBeenCalled();
    expect(importer.pending.value).toBeNull();
  });

  it("reserves endpoint slots and stops if the list fills before confirmation", async () => {
    const routeEnds = [
      { id: "wp-start", kind: "trailhead" as const, alongM: 0 },
      { id: "wp-end", kind: "end" as const, alongM: 1_000 },
    ];
    const current = ref<ListSnapshot | null>(snapshot("Empty list"));
    const addWaypoint = vi.fn();
    const target = {
      epoch: 1,
      snapshot: current,
      // The reducer seeds route ends when geometry changes. Keep this focused target
      // faithful to that observable contract, then verify optional pins use the room left.
      setMeta: vi.fn(() => { current.value!.waypoints = routeEnds; }),
      addWaypoint,
      updateWaypoint: vi.fn(),
    };
    const importer = useGpxImport(current, target);
    const bytes = new TextEncoder().encode(trackWithPins);
    const file = {
      size: bytes.length,
      slice: () => ({ arrayBuffer: async () => bytes.buffer }),
      arrayBuffer: async () => bytes.buffer,
      text: async () => trackWithPins,
    };
    const input = document.createElement("input");
    Object.defineProperty(input, "files", { value: [file] });

    await importer.onGpx({ target: input } as unknown as Event);

    expect(importer.pending.value?.pins).toHaveLength(MAX_FILE_PINS - routeEnds.length);
    // A collaborator can consume the remaining slots while the optional-pin choice is
    // visible. Confirmation must not enqueue one more mutation for the reducer to drop.
    current.value!.waypoints = Array.from({ length: MAX_FILE_PINS }, (_, i) => ({
      id: `waypoint-${i}`,
      kind: "landmark" as const,
      alongM: i * 1_000,
    }));
    await importer.confirmPins();
    expect(addWaypoint).not.toHaveBeenCalled();
  });
});
