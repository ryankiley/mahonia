import { ref, watch, type Ref } from "vue";
import { profileToString } from "~~/shared/profile";
import { cumulativeM, decodePolyline, nearestAlongM, routeGeometryFromPoints } from "~~/shared/polyline";
import type { FilePin } from "~~/shared/gpx";
import { MAX_LABEL_LEN, MAX_WAYPOINTS, type Op } from "~~/shared/ops";
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
 * deriving names. And when it does write over one somebody typed, it says so and
 * holds the old figure for one tap (`replaced`, below).
 */

/** How close two pins have to be before the second one is just the first one again. */
const PIN_DEDUP_M = 60;
/** How far a file's distance has to be from the typed one before the swap is worth a
 *  word: 2% of it, and never less than 100 m. Two honest measurements of one trail
 *  differ by about that much. */
const REPLACED_MIN_SHARE = 0.02;
const REPLACED_MIN_M = 100;

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
  /** The controller's list lifetime (useGearList's epoch): a file is read
   *  asynchronously through a SINGLETON, so a parse that finishes after the editor
   *  has moved on must not write its route into the list opened next. Optional —
   *  a focused caller without a controller has nothing to outlive. A ref, because
   *  the held pin offer has to react to it, not only compare it. */
  readonly epochRef?: Readonly<Ref<number>>;
  snapshot: Ref<ListSnapshot | null>;
  addWaypoint: (alongM: number, kind: WaypointKind) => void;
  updateWaypoint: (id: string, patch: { label?: string }) => void;
  setMeta: (patch: Extract<Op, { t: "setMeta" }>["patch"]) => void;
}

export function useGpxImport(c: GpxTarget) {
  const gpxError = ref("");
  const gpxBusy = ref(false);
  // Which read owns the outcome: a second file chosen while the first is still
  // parsing supersedes it, and so does the list changing underneath (see GpxTarget).
  let reads = 0;
  const targetEpoch = () => c.epochRef?.value;

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
    /** the list the offer was made for — a yes given to another list is no answer */
    epoch: number | undefined;
  } | null>(null);

  /**
   * A typed distance the file's own just took the place of, held until it is answered.
   *
   * A list with no route yet can still have a distance: the one read off a sign or a
   * trip report and typed in. Importing a file wrote its measurement over that without a
   * word (18 mi became 8.2), and the only way to notice was to remember the old number.
   * So the swap is SAID, with the old figure one tap away. Only for a distance nobody's
   * file put there: replacing one file with another changes the distance as a matter of
   * course. And only when the two differ by more than a track's own noise, so a typed
   * "8.2" beside a measured 8.23 says nothing.
   */
  const replaced = ref<{ wasM: number; nowM: number; epoch: number | undefined } | null>(null);
  function keepTyped() {
    const r = replaced.value;
    replaced.value = null;
    if (!r || r.epoch !== targetEpoch()) return;
    c.setMeta({ trailDistanceM: r.wasM });
  }
  // The notice is about the figure the file wrote. Once the distance is anything else
  // (typed over, cleared, or changed by someone else on the list) it has nothing to say.
  watch(
    () => c.snapshot.value?.trailDistanceM,
    (d) => {
      if (replaced.value && d !== replaced.value.nowM) replaced.value = null;
    },
  );

  async function confirmPins() {
    const p = pending.value;
    pending.value = null;
    if (!p || p.epoch !== targetEpoch()) return;
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
    const taken = (c.snapshot.value?.waypoints ?? []).map((w) => w.alongM);
    // The room left is re-read HERE, not only when the offer was made: it can sit open
    // for minutes while a collaborator fills the list, and the reducer drops any pin
    // past its cap without a word — so stop where it would, rather than queue ops it
    // will refuse.
    let room = Math.max(0, MAX_WAYPOINTS - taken.length);
    for (const pin of p.pins) {
      if (!room) break;
      const alongM = nearestAlongM(line, pin, cum);
      if (alongM < 0 || alongM > total) continue;
      // Don't re-place the ends the reducer seeded with the route, and don't stack two
      // pins a person would read as one. Checked against what's ALREADY there, so it
      // holds for a second import onto an existing set too.
      if (taken.some((t) => Math.abs(t - alongM) < PIN_DEDUP_M)) continue;
      taken.push(alongM);
      c.addWaypoint(alongM, p.kindOf(pin));
      room--;
      // The label is a separate op because addWaypoint mints the id — see useGearList.
      // The reducer sorts by alongM, so the pin just added is findable by the position
      // we gave it.
      if (pin.name) {
        const made = (c.snapshot.value?.waypoints ?? []).find((w) => w.alongM === alongM);
        if (made) c.updateWaypoint(made.id, { label: pin.name.slice(0, MAX_LABEL_LEN) });
      }
    }
  }

  async function onGpx(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // so choosing the same file twice still fires a change
    if (!file) return;
    const mine = ++reads;
    const epoch = targetEpoch();
    // still the read that matters, and still the list it was chosen for
    const current = () => mine === reads && epoch === targetEpoch();
    gpxError.value = "";
    gpxBusy.value = true;
    pending.value = null;
    replaced.value = null;
    try {
      // The reader arrives HERE, on the one interaction that needs it — several hundred
      // lines of XML dialects, a zip decoder and GeoJSON that would otherwise ride the
      // first load of every packing list. `gpxBusy` is already true, so the fetch shows
      // as "Reading…" like the parse it precedes.
      const { pinKind, readRouteFile } = await import("~~/shared/gpx");
      if (!current()) return;
      const read = await readRouteFile(file);
      // the reads inside are where a navigation slips in; everything past here is sync
      if (!current()) return;
      if (read === "too-big") {
        gpxError.value = ROUTE_FILE_TOO_BIG;
        return;
      }
      // The pins the file carried are offered, not applied: see confirmPins.
      const { points, pins, stats } = read;
      const geometry = routeGeometryFromPoints(points) ?? "";
      // read before the write below: a distance with no file behind it is one somebody typed
      const before = c.snapshot.value;
      const typedM = before && !before.trailProfile && !before.routeGeometry ? before.trailDistanceM : undefined;
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
      // reseeds them from the geometry whenever it changes (see seedRouteEnds), and it is
      // the only thing that does: an addWaypoint here would mint a second trailhead and a
      // second finish on the same two metres, in the plan's list and on the map, and
      // another pair on every re-import of the same file.
      // Everything else the file offered is an OFFER. A track can carry thousands of pins;
      // fifty is not glanceable and undoing them is fifty taps, so it waits for a yes.
      // Offered only as many as the list can still hold — after the ends the setMeta
      // above just seeded — so the question is answerable as asked: "add 98" is what
      // will happen, where "add 400" was 98 added and the rest dropped in silence.
      const room = Math.max(0, MAX_WAYPOINTS - (c.snapshot.value?.waypoints?.length ?? 0));
      const offered = pins.slice(0, room);
      pending.value = geometry && offered.length ? { geometry, pins: offered, kindOf: pinKind, epoch } : null;
      // what the list holds now, which is the reducer's clamped figure and not ours
      const nowM = c.snapshot.value?.trailDistanceM;
      if (typedM && nowM && Math.abs(nowM - typedM) > Math.max(REPLACED_MIN_M, typedM * REPLACED_MIN_SHARE))
        replaced.value = { wasM: typedM, nowM, epoch };
    } catch {
      if (current()) gpxError.value = ROUTE_FILE_UNREADABLE;
    } finally {
      if (mine === reads) gpxBusy.value = false;
    }
  }

  // The offer, the error and the busy label are all about ONE list. The controller
  // is a singleton, and `dispose(); startDraft()` swaps its list in a single tick
  // without unmounting the head that shows them — so they clear on the epoch, not
  // on a remount that may never come.
  if (c.epochRef) {
    watch(c.epochRef, () => {
      reads++;
      pending.value = null;
      replaced.value = null;
      gpxError.value = "";
      gpxBusy.value = false;
    });
  }

  return { gpxError, gpxBusy, pending, confirmPins, replaced, keepTyped, onGpx };
}
