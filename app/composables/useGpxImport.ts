import { ref, type Ref } from "vue";
import { profileToString } from "~~/shared/profile";
import { cumulativeM, decodePolyline, nearestAlongM, routeGeometryFromPoints } from "~~/shared/polyline";
import type { FilePin } from "~~/shared/gpx";
import type { Op } from "~~/shared/ops";
import type { ListSnapshot, WaypointKind } from "~~/shared/types";

/**
 * Reading a route out of a file the person picked.
 *
 * Split out of ListHead, which had grown a whole import pipeline in the middle of a
 * component that otherwise lays out a title, some dates and a trail link. It only
 * ever touched three things from around it — the snapshot, addWaypoint and setMeta —
 * so it lifts cleanly, and the file it came from gets ~140 lines shorter.
 *
 * Read HERE, in the browser. No upload and no request — the site's CSP is
 * `connect-src 'self'`, so sending it anywhere isn't an option that exists, which
 * makes "it never leaves your browser" a fact rather than a promise.
 *
 * The map added ONE host to `img-src`, and that leaves this untouched: `img-src`
 * governs where pictures may be fetched FROM, while `connect-src` is what would have
 * to loosen before any bytes could be sent OUT. It is still `'self'`, and
 * tests/csp.test.ts fails if that ever stops being true.
 *
 * It FILLS IN the route's distance and shape; it does not take them over. The
 * distance stays an editable field afterwards, so a mangled track can't quietly
 * rewrite a number somebody typed — the same conservatism trailLink.ts applies to
 * deriving names.
 */

/** How close two pins have to be before the second one is just the first one again. */
const PIN_DEDUP_M = 60;

/** The slice of the editor this needs. Narrow on purpose: everything it can reach is
 *  everything it could break, and a route import has no business anywhere else.
 *
 *  `setMeta` takes the REDUCER's own patch type rather than a loose bag. Typing it
 *  `Record<string, unknown>` compiled — a weak all-optional target accepts it — but
 *  it turned off excess-property checking at the one call site that matters: a
 *  mistyped key (`trailAscentMeters`) would have built green, failed the reducer's
 *  `typeof` guard, and dropped the climb off an imported route with no error
 *  anywhere. Inline in ListHead that was a compile error, and it is again. */
interface GpxTarget {
  snapshot: Ref<ListSnapshot | null>;
  addWaypoint: (alongM: number, kind: WaypointKind) => void;
  updateWaypoint: (id: string, patch: { label?: string }) => void;
  setMeta: (patch: Extract<Op, { t: "setMeta" }>["patch"]) => void;
}

export function useGpxImport(snapshot: Ref<ListSnapshot | null>, c: GpxTarget) {
  const gpxError = ref("");
  const gpxBusy = ref(false);

  /**
   * Pins the file offered, held until someone says yes.
   *
   * `kindOf` rides along rather than being re-imported: it comes out of the same lazy
   * chunk the file was read with, and by the time this is confirmed that chunk is
   * already loaded.
   */
  const pending = ref<{
    geometry: string;
    pins: FilePin[];
    kindOf: (p: Pick<FilePin, "sym" | "name">) => WaypointKind;
  } | null>(null);

  async function confirmPins() {
    const p = pending.value;
    pending.value = null;
    if (!p) return;
    // polyline is a static import (this file already had it at the top for the
    // geometry); it's shared/gpx.ts that stays a lazy chunk, see onGpx
    const line = decodePolyline(p.geometry);
    if (line.length < 2) return;
    // the spine once, for every pin's projection — see the walkers in shared/polyline.ts
    const cum = cumulativeM(line);
    const total = cum.at(-1) ?? 0;
    // Every pin PROJECTS onto the line, because a waypoint is a distance along the route
    // and not a coordinate. A water source 200 m off-trail is recorded where you'd leave
    // the trail for it, which is the useful place to be told about it.
    const taken = (snapshot.value?.waypoints ?? []).map((w) => w.alongM);
    for (const pin of p.pins) {
      const alongM = nearestAlongM(line, pin, cum);
      if (alongM < 0 || alongM > total) continue;
      // Don't re-place the ends the reducer seeded with the route, and don't stack two
      // pins a person would read as one. Checked against what's ALREADY there, so it
      // holds for a second import onto an existing set too.
      if (taken.some((t) => Math.abs(t - alongM) < PIN_DEDUP_M)) continue;
      taken.push(alongM);
      c.addWaypoint(alongM, p.kindOf(pin));
      // The label is a separate op because addWaypoint mints the id — see useGearList.
      // The reducer sorts by alongM, so the pin just added is findable by the position
      // we gave it.
      if (pin.name) {
        const made = (c.snapshot.value?.waypoints ?? []).find((w) => w.alongM === alongM);
        if (made) c.updateWaypoint(made.id, { label: pin.name.slice(0, 120) });
      }
    }
  }

  async function onGpx(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // so choosing the same file twice still fires a change
    if (!file) return;
    gpxError.value = "";
    gpxBusy.value = true;
    try {
      // The reader arrives HERE, on the one interaction that needs it — several hundred
      // lines of XML dialects, a zip decoder and GeoJSON that would otherwise ride the
      // first load of every packing list. `gpxBusy` is already true, so the fetch shows
      // as "Reading…" like the parse it precedes.
      const { MAX_GPX_BYTES, filePins, geoJsonPoints, gpxPoints, gpxStats, kmzToKml, pinKind } =
        await import("~~/shared/gpx");
      // Checked BEFORE reading. DOMParser on a 30 MB string blocks the main thread for
      // seconds; declining is cheaper than a worker, and honest. (After the import rather
      // than before it only because the limit lives with the reader — a chunk fetch is
      // not the expensive part, the parse is.)
      if (file.size > MAX_GPX_BYTES) {
        gpxError.value = "That file is too big to read here.";
        return;
      }
      // A KMZ is a zip, so it has to be unwrapped before anything can read it. Sniffed by
      // its "PK" signature rather than its name, like the format check below.
      const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      const text =
        head[0] === 0x50 && head[1] === 0x4b
          ? ((await kmzToKml(await file.arrayBuffer())) ?? "")
          : await file.text();
      if (!text) throw new Error("empty");
      // JSON or XML, decided by the CONTENT rather than the extension — a file saved as
      // .txt or renamed by a share sheet is still the route it was, and the first
      // non-space character tells us which family it belongs to more reliably than a name.
      const first = text.trimStart()[0];
      let points;
      let pins: FilePin[] = [];
      if (first === "{" || first === "[") {
        points = geoJsonPoints(JSON.parse(text));
      } else {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        if (doc.querySelector("parsererror")) throw new Error("not xml");
        // gpxPoints reads GPX, KML and TCX — same track, different dialects
        points = gpxPoints(doc);
        // The pins the file carried, read SEPARATELY from the track and deliberately not
        // applied yet — see confirmPins. gpxPoints never touches <wpt>, and that
        // separation is load-bearing: a KML's marker placemarks once inflated a 39.8-mile
        // trail to 58.5.
        pins = filePins(doc);
      }
      const stats = gpxStats(points);
      if (!stats) throw new Error("no track");
      const geometry = routeGeometryFromPoints(points) ?? "";
      c.setMeta({
        trailDistanceM: stats.distanceM,
        trailProfile: profileToString(stats.profile) ?? "",
        // the route's SHAPE, simplified to fit its budget — see shared/polyline.ts
        routeGeometry: geometry,
        // measured across the FULL track, not the stored profile — see trailAscentM
        trailAscentM: stats.ascentM,
        trailDescentM: stats.descentM,
      });
      // The ends come with the route, and NOTHING HERE PLACES THEM. The reducer's setMeta
      // reseeds them from the geometry whenever it changes (see seedRouteEnds), with fixed
      // ids, which is what makes a repeat import idempotent. This used to add them a
      // second time straight after the setMeta above; because addWaypoint mints a fresh id
      // and the reducer dedupes on id alone, that produced two trailheads and two finishes
      // stacked on the same two metres — in the plan's list and on the map — and another
      // pair on every re-import of the same file. If a call is ever needed here again it is
      // c.ensureRouteEnds(), which dedupes on those fixed ids.
      // Everything else the file offered is an OFFER. A track can carry thousands of pins;
      // fifty is not glanceable and undoing them is fifty taps, so it waits for a yes.
      pending.value = geometry && pins.length ? { geometry, pins, kindOf: pinKind } : null;
    } catch {
      gpxError.value = "Couldn't read a route out of that file.";
    } finally {
      gpxBusy.value = false;
    }
  }

  return { gpxError, gpxBusy, pending, confirmPins, onGpx };
}
