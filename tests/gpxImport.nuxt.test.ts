// @vitest-environment nuxt
//
// A GPX file is read asynchronously, while the editor controller is a singleton.
// That makes list navigation during a file read a real ownership boundary: a late
// parser result must not write the route into whatever list was opened next.
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useGpxImport } from "~/composables/useGpxImport";
import type { ListSnapshot } from "~~/shared/types";

const snapshot = (title: string): ListSnapshot => ({
  shareCode: "SNAPCODE0001",
  slug: "test-list",
  title,
  description: "",
  displayUnit: "g",
  folders: [],
  items: [],
  version: 1,
  isPublic: false,
});

const track = `<?xml version="1.0"?>
<gpx version="1.1"><trk><trkseg>
  <trkpt lat="45.5000" lon="-121.7000"><ele>1000</ele></trkpt>
  <trkpt lat="45.5100" lon="-121.6900"><ele>1100</ele></trkpt>
</trkseg></trk></gpx>`;

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
});
