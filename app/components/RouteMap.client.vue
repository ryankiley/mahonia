<script setup lang="ts">
import { dayColorSequence } from "~~/shared/categories";
import { cumulativeM, decodePolyline, formatLatLon, nearestAlongM, pointAlong, sliceAlong, type LatLon } from "~~/shared/polyline";
import { HugeiconsIcon, type IconNode } from "~/utils/hugeicon";
import { ArrowExpand02Icon, ArrowShrink02Icon, HelpCircleIcon } from "@hugeicons/core-free-icons";
import { formatDistance, type DisplayDistanceUnit } from "~~/shared/trailDistance";
import { waypointKindMeta } from "~/utils/waypointKinds";

// Where the route actually goes — the other half of the elevation profile's answer.
//
// The profile says what the walking is like; this says where it is. They're deliberately
// the same drawing twice: one line per day, in the same colours, so reading "day 2 is the
// climb" off the chart and finding day 2 on the map is one glance rather than two.
//
// THIS COMPONENT IS THE APP'S ONLY THIRD-PARTY REQUEST. Everything else the site serves,
// it serves itself. That is a property worth naming, because it's the thing this file
// spends: the CSP gains exactly one host, in `img-src`, because raster tiles are <img>.
// `connect-src` stays 'self', so nothing here can fetch, and `script-src` stays 'self',
// so Leaflet is bundled rather than linked — a CDN <script> could read `location.hash`,
// where a list's edit token lives. See nuxt.config.ts and tests/csp.test.ts.
//
// `.client` and dynamically imported: Leaflet touches `window` at module scope, and the
// ~45 KB belongs in its own chunk. Someone making a packing list should never pay for a
// map they didn't open — the parent renders this only when a route exists, so no GPX
// means the chunk is never even requested.
const props = defineProps<{
  /** the stored encoded polyline — this component is only mounted when there is one */
  geometry: string;
  /** each day's distance in metres, in order; the same cuts the elevation profile makes */
  dayDistancesM: number[];
  /** the pins on this route. Owner-only data — this component only ever renders on /e. */
  waypoints?: { id: string; kind: string; alongM: number; label?: string }[];
  /**
   * Placing mode, and WHICH STRETCH is being placed on — a day's leg, or the ground no
   * day claims. Null is off.
   *
   * A range rather than a boolean because the affordance lives in a day: pressing "Add a
   * waypoint" on day 3 has to put the pin in day 3, the way "Add an item" in a folder puts
   * the item in that folder. So the armed stretch is the only lit part of the route and a
   * tap is clamped into it — a tap that lands elsewhere is a mis-tap, and clamping to the
   * near end is the forgiving reading of it rather than a surprise.
   */
  armedRange?: { fromM: number; toM: number } | null;
  /** how a pin's distance reads in its popup — the reader's own choice, not the file's */
  distanceUnit?: DisplayDistanceUnit;
  /**
   * Where the elevation chart's cursor is, as a distance along this route. Null when
   * nothing is being traced.
   *
   * A distance rather than a coordinate because that is all the chart has — it holds
   * elevations and has never seen a latitude. Walking the polyline to a point is this
   * component's job, and it is the same walk a waypoint's own position takes.
   */
  traceM?: number | null;
  /**
   * Where the walk ENDS, when the itinerary actually reaches the end of the route — the
   * same derived fact the last day's row carries (see finishOf in TrailPlanPanel), not a
   * stored pin.
   *
   * Drawn here rather than seeded as a waypoint because on a LOOP the finish is the
   * trailhead: one coordinate, and two stored pins on it would be two markers stacked on
   * the same spot. Painted after the pins, so in that case the chequered flag simply sits
   * over the plain one and the reader sees the one mark that is true of that place — it is
   * where you start AND where you stop.
   */
  finishM?: number | null;
}>();

const emit = defineEmits<{
  place: [alongM: number];
  /** a pin dropped somewhere new, as one op at the end of the gesture */
  move: [at: { id: string; alongM: number }];
  /** a pin named from its own popup, rather than from its row */
  rename: [at: { id: string; label: string }];
  /** a pin deleted from its own popup */
  remove: [id: string];
  /**
   * A day boundary dropped somewhere new: day `index` now ends here, and whichever day
   * follows it starts here. The panel owns the arithmetic — it is the one that knows what
   * a day is — this only says where the handle came to rest.
   */
  boundary: [at: { index: number; alongM: number }];
}>();

const host = ref<HTMLElement | null>(null);
const failed = ref(false);
// Read synchronously, at setup, NOT inside draw(): draw() awaits the Leaflet import, and
// a Nuxt composable called after an await has lost the instance context — it returned an
// empty config, which silently produced `undefined/{z}/{x}/{y}.png` and 404'd every tile.
const tileOrigin = useRuntimeConfig().public.tileOrigin;
/** Leaflet's own types, but only inside the lazy chunk — the module is never statically
 *  imported, so `typeof import()` keeps the types without pulling the code into the entry. */
type Leaflet = typeof import("leaflet");
let L: Leaflet | null = null;
let map: import("leaflet").Map | null = null;
let tiles: import("leaflet").TileLayer | null = null;
let legs: import("leaflet").Polyline[] = [];
let pins: import("leaflet").Marker[] = [];
let bounds: import("leaflet").Marker[] = [];
// ONE marker, kept and moved rather than a list rebuilt — see renderTrace.
let trace: import("leaflet").Marker | null = null;
let finish: import("leaflet").Marker | null = null;
let ro: ResizeObserver | null = null;

const points = computed<LatLon[]>(() => decodePolyline(props.geometry));

// ONE sequence, read by the legs and by the chevrons alike. Computed twice it was two
// calls that happened to agree — and a chevron in a colour its own leg isn't drawn in is
// the exact bug that costs nothing to make impossible.
const colors = computed(() => dayColorSequence(props.dayDistancesM.length));

/**
 * The route cut into days, each with the colour that day wears on the elevation chart.
 *
 * The denominator matches the profile's: distances are laid end to end from the start, and
 * anything past the last assigned day stays uncoloured rather than being stretched to fit.
 * A four-mile day on a twenty-mile route owns a fifth of the line, and the sixteen miles
 * nobody has claimed read as unclaimed — the same refusal to assert a plan that isn't
 * there.
 */
const dayLegs = computed(() => {
  const out: { points: LatLon[]; color: string; day: number; fromM: number; toM: number }[] = [];
  let run = 0;
  props.dayDistancesM.forEach((d, i) => {
    const fromM = run;
    const toM = run + d;
    const leg = sliceAlong(points.value, fromM, toM);
    run = toM;
    if (leg.length >= 2) {
      out.push({ points: leg, color: colors.value[i] ?? "var(--cat-other)", day: i + 1, fromM, toM });
    }
  });
  return out;
});

/**
 * How far a stretch stands down while another one is armed.
 *
 * Faded, never hidden: the rest of the route is still the context that tells you WHERE the
 * armed stretch is, and a line that vanished would leave a coloured fragment floating on a
 * contour sheet. Low enough that the target is unmistakable, high enough that the shape of
 * the walk survives.
 */
const DIM = 0.25;

/** The route's own length — the far end of anything that can be dragged along it. */
const routeLengthM = computed(() => cumulativeM(points.value).at(-1) ?? 0);

/** The shortest a day may be dragged down to. Below this it stops being a day. */
const MIN_DAY_M = 200;

/**
 * WHERE ONE DAY ENDS AND THE NEXT BEGINS — and it is where you sleep, which is why the
 * handle wears a tent.
 *
 * Derived, never stored. A boundary is just the running total through day K, so dragging
 * one is a way of TYPING TWO NUMBERS AT ONCE: day K gets longer by exactly what day K+1
 * gives up. Their sum can't change, so nothing before or after the pair moves, and the
 * itinerary stays the single source of how long the trip is.
 *
 * The last one is different in kind: it bounds the final day against the ground nobody has
 * claimed, so dragging it lengthens or shortens that day alone and the grey tail absorbs
 * the difference. That is how you say "the route runs on past my plan".
 *
 * It is NOT a waypoint, and shouldn't become one on its own. Boundaries move constantly
 * while a trip is being planned; waypoints are the walker's own marks with their own
 * lifecycle, and removeDay has no cascade by deliberate design. So this reads as a camp
 * without being one — until somebody drops a real pin there because they have something to
 * say about it.
 */
const boundaries = computed(() => {
  const d = props.dayDistancesM;
  const total = routeLengthM.value;
  const out: { index: number; alongM: number; minM: number; maxM: number }[] = [];
  let run = 0;
  for (let i = 0; i < d.length; i++) {
    const fromM = run;
    run += d[i] ?? 0;
    if (!(d[i]! > 0)) continue;
    // the next day that owns any ground; blanks in between own none and can't be traded with
    const nextI = d.findIndex((v, k) => k > i && v > 0);
    const minM = fromM + MIN_DAY_M;
    if (nextI < 0) {
      // the last planned day, against the unclaimed tail
      if (run < total - MIN_DAY_M && minM < total) out.push({ index: i, alongM: run, minM, maxM: total });
      continue;
    }
    const maxM = run + d[nextI]! - MIN_DAY_M;
    if (minM < maxM) out.push({ index: i, alongM: run, minM, maxM });
  }
  return out;
});

/**
 * A leg's casing: its own colour, taken down toward black.
 *
 * `color-mix` in oklab rather than a hand-picked second palette — oklab is perceptually
 * even, so one mix ratio darkens every hue by the same apparent amount instead of turning
 * the yellows muddy and leaving the blues untouched. And it reads the leg's token, so a
 * change to the day palette carries here for free.
 */
const casingFor = (color: string) => `color-mix(in oklab, ${color} 45%, #0b0b0b)`;

/**
 * The leg's own fill: the same hue, LIFTED.
 *
 * The two strokes have to be told apart at 4px against a sheet with its own colours in it,
 * and a casing only slightly darker than its fill reads as one soft-edged line rather than
 * a line with an edge. Taking the inside up as the outside goes down opens the gap from
 * both directions, so the route keeps a crisp edge without the casing going so black that
 * the day's colour stops being legible in it.
 */
const fillFor = (color: string) => `color-mix(in oklab, ${color} 82%, #ffffff)`;

/** Whether a stretch of the route is outside the armed one, and so should stand down. */
function isDimmed(fromM: number, toM: number): boolean {
  const a = props.armedRange;
  return !!a && (toM <= a.fromM || fromM >= a.toM);
}


/**
 * Whether the person looking at this has moved the map themselves.
 *
 * Until they have, the view is ours to manage and the whole route should stay in frame.
 * The moment they pan or zoom, it is theirs and we stop touching it — re-framing under
 * somebody who has just zoomed in on a col is the rudest thing a map can do.
 */
let touched = false;
/** Set while WE are moving the map, so our own framing doesn't read as a gesture. */
let framing = false;

/** Put the whole TRACK in view — not the legs, which would crop the ground no day claims. */
function frame() {
  if (!map || !L) return;
  framing = true;
  const all = points.value.map((p) => [p.lat, p.lon] as [number, number]);
  // `animate: false` is what makes the flag above sufficient: the move happens inside this
  // call and fires its events here, rather than landing after the flag is cleared.
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [16, 16], animate: false });
  else map.setView([0, 0], 2, { animate: false });
  framing = false;
}

/**
 * A Hugeicon as an SVG STRING.
 *
 * Leaflet's divIcon takes HTML, not a component, so the glyph can't be rendered by
 * <HugeiconsIcon> the way it is everywhere else in the app — it has to be serialised. The
 * icon data is a plain `[tag, attrs][]` array from the bundled package, which is why this
 * is a dozen lines rather than a dependency.
 *
 * The per-path `stroke-width` is DROPPED and set once on the <svg>. The set draws in a
 * 24-unit box at 1.5, which scales to a 0.7px hairline at pin size — invisible against
 * contour lines. Setting it here lets the paths inherit a weight chosen for the size
 * they're actually drawn at.
 */
/**
 * The drop. Big enough to hold a legible glyph, small enough not to bury the terrain.
 *
 * 22px was sized for a coloured disc, where the fill did the finding and the glyph was a
 * detail you read once you had found it. Inverting that — white drop, coloured mark — put
 * the whole job on the glyph, and a 13px mark on a sheet of contour lines and place names
 * is not a mark, it is a smudge. 30 gives the symbol room to be a droplet or a tent rather
 * than a dark blob, which is the entire reason for drawing one.
 *
 * Not larger: two pins a few hundred metres apart have to stay two pins, and a route on a
 * 320px map is only a few centimetres of switchbacks.
 */
const PIN_PX = 30;
/**
 * What the (?) under the map says.
 *
 * The press-and-hold is named only once there is a pin to try it on — until then it
 * describes something that isn't on screen. The ⌘ line stays either way: it used to be
 * hidden on a coarse pointer, because a caption naming a key you don't have is noise, but
 * inside a tooltip nobody opens by accident it costs nothing — and a touch laptop has both
 * a finger and a ⌘, which the media query was quietly wrong about.
 */
const gestures = computed(() =>
  [
    "Hold ⌘ or Ctrl while scrolling to zoom.",
    props.waypoints?.length ? "Press and hold a pin to move it along the route." : "",
  ]
    .filter(Boolean)
    .join(" "),
);

/** The traced dot. Smaller than a pin: it is a reading, not a thing somebody placed. */
const TRACE_PX = 12;
/**
 * How far down the box the drop's POINT actually falls.
 *
 * The teardrop is a square turned 45° (see the CSS), so what reads as its tip is the
 * bottom corner of that rotation — half the box down, plus half the rotated diagonal.
 * On a 30px box that is 36.2, not 30: the drop hangs 6px BELOW the bottom edge of its
 * own icon box, because a rotated square does not fit inside the square it started as.
 *
 * Anchoring at PIN_PX, the box's bottom edge, therefore put every pin's point six pixels
 * below the metre of route it marks — tens of metres at the zoom you place one at, and
 * the exact opposite of what the anchor comments claim.
 */
const PIN_TIP_PX = PIN_PX / 2 + (PIN_PX * Math.SQRT2) / 2;
const PIN_GLYPH_PX = 17;
const PIN_GLYPH_STROKE = 2;
function iconSvg(icon: IconNode): string {
  const body = icon
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        // `key` is Vue's list hint and strokeWidth is set on the parent; neither is SVG
        .filter(([k]) => k !== "key" && k !== "strokeWidth")
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}="${String(v).replace(/[<>&"]/g, "")}"`)
        .join(" ");
      return `<${tag} ${a}/>`;
    })
    .join("");
  return `<svg viewBox="0 0 24 24" width="${PIN_GLYPH_PX}" height="${PIN_GLYPH_PX}" fill="none" stroke-width="${PIN_GLYPH_STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/**
 * MOVING A PIN: press and hold, then slide.
 *
 * Not a plain drag, and not Leaflet's own `draggable` marker option, because this map is
 * also a pan surface: a plain drag beginning on a 22px disc is far more often somebody
 * moving the MAP than somebody moving the pin, and getting that wrong silently relocates a
 * water source. The hold is the statement of intent — the same gesture that means "pick
 * this up" everywhere else on a touchscreen.
 *
 * Leaflet's handler couldn't do it anyway: its Marker.Drag binds on mousedown, so enabling
 * it once a hold has already elapsed picks up nothing, and the person would have to let go
 * and start again. Doing the move here also buys the thing that makes it feel right — the
 * pin follows the ROUTE, not the finger.
 */
/** How long a press has to hold still before the pin lifts. */
const LIFT_MS = 400;
/** How far it may wander in that time before it counts as a pan instead of a hold. */
const LIFT_SLOP_PX = 10;
/** How much of the route either side of the pin a single move step may reach. */
const LIFT_WINDOW_M = 3000;

type Lift = {
  el: HTMLElement;
  marker: import("leaflet").Marker;
  alongM: number;
  /** the stretch of route this thing is allowed to occupy */
  minM: number;
  maxM: number;
  /** one op, or two, at the end of the gesture — never during it */
  commit: (alongM: number) => void;
};
let lift: Lift | null = null;
/**
 * Set through any gesture that was ABOUT AN EXISTING PIN, so the click it generates can't
 * also place a new one on an armed map. Two of them do this: the pointerup that ends a
 * move, and the click that opens a pin's popup. Both leave a click behind them, and both
 * had already said what they meant.
 */
let suppressPlace = false;
/** Suppress through the end of this event turn — long enough for the click that follows. */
function suppressPlaceOnce() {
  suppressPlace = true;
  setTimeout(() => (suppressPlace = false), 0);
}

function onGrab(e: PointerEvent, spec: Omit<Lift, "el">) {
  if (e.button > 0 || lift) return;
  const el = e.currentTarget as HTMLElement;
  const x0 = e.clientX;
  const y0 = e.clientY;

  // On the WINDOW rather than the pin, and deliberately not captured yet: a pan that
  // happens to start on a pin has to keep working, and capturing here would take the
  // moves away from Leaflet before we know which gesture this is.
  const watch = (m: PointerEvent) => {
    if (Math.hypot(m.clientX - x0, m.clientY - y0) > LIFT_SLOP_PX) stop();
  };
  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener("pointermove", watch);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
  const timer = setTimeout(() => {
    stop();
    beginLift(el, spec, e.pointerId);
  }, LIFT_MS);

  window.addEventListener("pointermove", watch);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}

function beginLift(el: HTMLElement, spec: Omit<Lift, "el">, pointerId: number) {
  if (!map) return;
  lift = { ...spec, el };
  el.classList.add("is-lifted");
  // the map must hold still while the pin moves, or both travel at once
  map.dragging.disable();
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* the pointer may already be gone; the window listeners below still finish the job */
  }
  // the small confirmation that the hold registered, where the hardware offers one
  navigator.vibrate?.(10);
  window.addEventListener("pointermove", onLiftMove);
  window.addEventListener("pointerup", endLift);
  window.addEventListener("pointercancel", endLift);
}

/**
 * The pin follows the ROUTE, not the pointer.
 *
 * A waypoint's position is a distance along the line and cannot be anything else, so the
 * drag projects onto the line at every step rather than letting the pin off it and
 * snapping back at the end. What you see while moving is what gets stored — no jump on
 * release, and no way to ask for a position the model can't hold.
 */
function onLiftMove(e: PointerEvent) {
  if (!lift || !map) return;
  e.preventDefault();
  const p = map.mouseEventToLatLng(e as unknown as MouseEvent);
  // ONLY THE STRETCH NEAR WHERE THE PIN ALREADY IS, and on a loop this is the whole
  // difference between a drag and a teleport. "Nearest point on the route" is genuinely
  // ambiguous at a loop's seam — the first mile and the last one are the same ground — so
  // nudging a pin at mile 3 could snap it to mile 36. Measured on the real Timberline: a
  // 70px drag moved a pin 33 miles.
  //
  // The window travels WITH the pin, because lift.alongM updates on every move. So a
  // continuous drag can still walk a pin the length of the route; what it can't do is
  // jump there, which is the only thing that was ever a mistake.
  const from = Math.max(0, lift.alongM - LIFT_WINDOW_M);
  const near = sliceAlong(points.value, from, lift.alongM + LIFT_WINDOW_M);
  if (near.length < 2) return;
  // CLAMPED to what this thing may occupy. A pin may go anywhere on the route; a day
  // boundary may not cross its neighbours, because a day it dragged past would end before
  // it began. The window above keeps the drag continuous, this keeps it legal.
  const raw = from + nearestAlongM(near, { lat: p.lat, lon: p.lng });
  const alongM = Math.min(lift.maxM, Math.max(lift.minM, raw));
  const at = pointAlong(points.value, alongM);
  if (!at) return;
  lift.alongM = alongM;
  lift.marker.setLatLng([at.lat, at.lon]);
}

function endLift() {
  const l = lift;
  lift = null;
  window.removeEventListener("pointermove", onLiftMove);
  window.removeEventListener("pointerup", endLift);
  window.removeEventListener("pointercancel", endLift);
  map?.dragging.enable();
  if (!l) return;
  l.el.classList.remove("is-lifted");
  suppressPlaceOnce();
  // ONE op for the whole gesture, committed on the drop — the codebase's own rule for
  // anything continuous. Live commits would be a hundred ops and a hundred autosaves for
  // one drag, and every one of them a separate undo.
  l.commit(l.alongM);
}

/**
 * Draw the pins.
 *
 * A waypoint stores only a DISTANCE, so its position is walked out of the polyline here —
 * which is the whole reason no coordinate is ever stored for one.
 *
 * The label goes on with textContent, never into the divIcon's html. That html is set as
 * innerHTML, and a label is text somebody typed on a list anyone with the link can open.
 */
/** The day-boundary handles. Same lift gesture as a pin, a different thing to commit. */
function renderBounds() {
  if (!map || !L) return;
  for (const m of bounds) m.remove();
  bounds = [];
  const line = points.value;
  const camp = waypointKindMeta("camp");
  for (const b of boundaries.value) {
    const at = pointAlong(line, b.alongM);
    if (!at) continue;
    const marker = L.marker([at.lat, at.lon], {
      keyboard: false,
      icon: L.divIcon({
        className: "routemap__bound",
        html: `<i>${iconSvg(camp.icon)}</i>`,
        iconSize: [PIN_PX, PIN_PX],
        // the tip, as a waypoint's is — the point is the metre of route it marks
        iconAnchor: [PIN_PX / 2, PIN_TIP_PX],
      }),
    }).addTo(map);
    // No tooltip, for the same reason the waypoints lost theirs: it named what the tent
    // already says and covered the ground around the thing being pointed at. Which day it
    // ends is in the row below, beside the distance and the coordinate.
    const el = marker.getElement();
    el?.addEventListener("pointerdown", (e) =>
      onGrab(e as PointerEvent, {
        marker,
        alongM: b.alongM,
        minM: b.minM,
        maxM: b.maxM,
        commit: (alongM) => emit("boundary", { index: b.index, alongM: Math.round(alongM) }),
      }),
    );
    el?.addEventListener("click", suppressPlaceOnce);
    bounds.push(marker);
  }
}

/**
 * The chart's cursor, shown on the ground.
 *
 * MOVED, not rebuilt. Every other mark here is torn down and re-added when its data
 * changes, which is fine for things that change when you edit them — this one changes on
 * every pointermove, and re-creating a marker sixty times a second thrashes the DOM and
 * makes the dot flicker. setLatLng moves the element that is already there.
 *
 * interactive: false is load-bearing rather than tidy. This dot sits ON the route line,
 * which is the tap target for placing a pin, and it follows a pointer that is somewhere
 * else entirely — over the chart. An interactive marker here would swallow taps meant for
 * the route at whatever spot the reader last hovered, which is a bug nobody would connect
 * back to the chart.
 */
function renderTrace() {
  if (!map || !L) return;
  const at = props.traceM == null ? null : pointAlong(points.value, props.traceM);
  if (!at) {
    trace?.remove();
    trace = null;
    return;
  }
  if (trace) {
    trace.setLatLng([at.lat, at.lon]);
    return;
  }
  trace = L.marker([at.lat, at.lon], {
    keyboard: false,
    interactive: false,
    icon: L.divIcon({
      className: "routemap__trace",
      html: "",
      iconSize: [TRACE_PX, TRACE_PX],
      // its CENTRE, unlike a pin's tip — this is a dot marking a point, not a drop
      // hanging above one
      iconAnchor: [TRACE_PX / 2, TRACE_PX / 2],
    }),
  }).addTo(map);
}

/** The finish, wearing the same chequered flag its row does. Not draggable: nobody put it
 *  there, the itinerary did, and it moves when the days do. */
function renderFinish() {
  if (!map || !L) return;
  finish?.remove();
  finish = null;
  const at = props.finishM == null ? null : pointAlong(points.value, props.finishM);
  if (!at) return;
  // ON A LOOP THERE IS ONE MARK, not two on one spot. The finish of a loop IS its
  // trailhead — the same coordinate — and that pin is already standing there wearing the
  // same chequered flag, so a second marker adds a click target and a redraw and nothing a
  // reader can see.
  //
  // Read off seedRouteEnds' own answer rather than re-deciding it: that function is the one
  // place that judges whether a route closes, and it records the verdict by seeding a start
  // and NO end. Measuring the two points again here would mean a second threshold, and two
  // thresholds eventually disagree.
  const wps = props.waypoints ?? [];
  if (wps.some((w) => w.kind === "trailhead") && !wps.some((w) => w.kind === "end")) return;
  const meta = waypointKindMeta("end");
  finish = L.marker([at.lat, at.lon], {
    keyboard: false,
    interactive: false,
    icon: L.divIcon({
      className: "routemap__pin routemap__pin--dark",
      html: `<i style="--pin:${meta.color}">${iconSvg(meta.icon)}</i>`,
      iconSize: [PIN_PX, PIN_PX],
      iconAnchor: [PIN_PX / 2, PIN_TIP_PX],
    }),
  }).addTo(map);
}

function renderPins() {
  if (!map || !L) return;
  for (const m of pins) m.remove();
  const line = points.value;
  pins = (props.waypoints ?? []).flatMap((w) => {
    const at = pointAlong(line, w.alongM);
    if (!at) return [];
    const meta = waypointKindMeta(w.kind);
    const marker = L!.marker([at.lat, at.lon], {
      keyboard: false,
      icon: L!.divIcon({
        // The route's own two ends invert — see the CSS. They are not a category of thing
        // found along the walk, they are where it starts and stops, and a solid mark says
        // that without needing a fifth hue.
        className: `routemap__pin${w.kind === "trailhead" || w.kind === "end" ? " routemap__pin--dark" : ""}`,
        // The GLYPH inside the disc, not a bare dot. Five colours alone asked the reader
        // to hold a legend in their head that the map has nowhere to print — a droplet
        // says "water" without one, and it still says it to somebody who can't separate
        // the blue from the violet.
        html: `<i style="--pin:${meta.color}">${iconSvg(meta.icon)}</i>`,
        iconSize: [PIN_PX, PIN_PX],
        // THE TIP, not the centre and not the box's bottom edge. The drop's point is the
        // claim — it lands on the metre of route the pin stores, and the body of the mark
        // sits above it out of the way of the line it is pointing at. See PIN_TIP_PX for
        // why the tip is not simply the bottom of the icon box.
        iconAnchor: [PIN_PX / 2, PIN_TIP_PX],
      }),
    }).addTo(map!);
    // NO TOOLTIP. It said what the pin's own glyph already says and what its row says
    // again, and it did so by covering the terrain around the thing you were pointing at —
    // on a map, the label was worth less than the ground it hid. Hovering grows the drop
    // instead (see the CSS): enough to answer "am I on it", which is the only question a
    // hover on a 30px target actually has. The popup on CLICK still carries the name, the
    // distance and the coordinate, for when you want them.
    const el = marker.getElement();
    el?.addEventListener("pointerdown", (e) =>
      onGrab(e as PointerEvent, {
        marker,
        alongM: w.alongM,
        minM: 0,
        maxM: routeLengthM.value,
        commit: (alongM) => emit("move", { id: w.id, alongM }),
      }),
    );
    // A click on a pin is about THAT pin: it opens the popup. Leaflet still lets it reach
    // the map, which on an armed map dropped a SECOND pin underneath the one you asked
    // about. Not disableClickPropagation — that would take the click the popup needs too.
    el?.addEventListener("click", suppressPlaceOnce);
    // The popup is built per OPEN, not once here: it has to show the pin's current name and
    // distance, and both change under it — a pin dragged to a new mile, or renamed in its
    // row, would otherwise open a popup still describing where it used to be.
    marker.bindPopup(() => pinPopup(w), { closeButton: true, autoPan: true, minWidth: 180 });
    marker.on("popupopen", () => {
      // a popup you have to click into before typing is a popup that wasted the tap
      (marker.getPopup()?.getElement()?.querySelector("input") as HTMLInputElement | null)?.focus();
    });
    return [marker];
  });
}

/**
 * Draw (or redraw) one line per day.
 *
 * Leaflet's default renderer is SVG, which is why the route can wear the app's own tokens
 * at all: every leg is a real <path> in the DOM. Its Canvas renderer would be pixels no
 * custom property can reach, and per-day colouring is the whole point of drawing it here.
 */
function renderLegs() {
  if (!map || !L) return;
  for (const line of legs) line.remove();
  legs = [];
  // The CASING first, so every coloured leg is drawn on top of it.
  //
  // Standard cartography, and here it is load-bearing rather than decorative: the basemap
  // is a topographic sheet with its own contours, streams and paths, and it draws paths in
  // MAGENTA — within a few degrees of the hue day 2 wears. Without a casing the route
  // stops being findable exactly where the map is most detailed, which is the ground you
  // most wanted to look at.
  //
  // A DARKER SHADE OF THE DAY'S OWN COLOUR, not white. White separated the route from the
  // sheet and cost the day its edge: the leg read as a coloured line laid inside a white
  // one, two marks where there is one thing. Darkening the same hue keeps the whole stroke
  // belonging to its day — the edge is the day, in shadow — and it separates just as well,
  // because what a contour line needs distinguishing from is a VALUE, not a colour.
  //
  // Done in oklab off the leg's own token, so it follows the palette rather than a second
  // list of nine colours that would drift the first time one of them changed.
  for (const leg of dayLegs.value) {
    legs.push(
      L!.polyline(
        leg.points.map((p) => [p.lat, p.lon] as [number, number]),
        {
          weight: 7,
          // the casing stands down WITH its leg, or a dimmed stretch reads as a white
          // line drawn over the terrain rather than as a quietened part of the route
          opacity: isDimmed(leg.fromM, leg.toM) ? DIM : 1,
          color: casingFor(leg.color),
          interactive: false,
          lineCap: "round",
          lineJoin: "round",
          className: "routemap__casing",
        },
      ).addTo(map!),
    );
  }
  for (const leg of dayLegs.value) {
    const line = L!.polyline(
      leg.points.map((p) => [p.lat, p.lon] as [number, number]),
      {
        weight: 4,
        opacity: isDimmed(leg.fromM, leg.toM) ? DIM : 1,
        lineCap: "round",
        lineJoin: "round",
        className: "routemap__leg",
      },
    ).addTo(map!);
    line.bindTooltip(`Day ${leg.day}`, { direction: "top", sticky: true });
    // Leaflet sets stroke as a PRESENTATION ATTRIBUTE, and no browser resolves `var()`
    // in one — so the token has to land as inline style instead, where custom properties
    // do work. Same value, one layer up the cascade.
    //
    // Requires the map to already have a view; see draw(). Without one the element
    // doesn't exist yet and the day's colour goes nowhere, which looks like a palette
    // bug rather than an ordering one — so say so out loud rather than drawing it wrong.
    const el = line.getElement() as SVGElement | null;
    if (el) el.style.stroke = fillFor(leg.color);
    else if (import.meta.dev) console.warn("[RouteMap] leg drawn before the map had a view");
    legs.push(line);
  }
}

/**
 * Zoom on ⌘/Ctrl + wheel — and, for free, on a trackpad pinch.
 *
 * The pinch is not a separate gesture to handle: macOS and Windows both report a trackpad
 * pinch as a wheel event with `ctrlKey` set, which is the very convention this gate is
 * built on. So one rule covers "hold the key and scroll" on a mouse and "pinch" on a
 * trackpad, and the caption only has to explain the one that needs explaining.
 *
 * `preventDefault` is what stops the BROWSER zooming the whole page out from under the
 * map on that same event — which is why the listener has to be non-passive.
 */
let wheelAcc = 0;
/** Roughly one zoom step per mouse notch, and a pinch that answers within a few frames. */
const WHEEL_PER_ZOOM = 60;
/** A wheel reporting LINES rather than pixels; about a line of text. */
const LINE_PX = 16;

function onWheel(e: WheelEvent) {
  if (!map) return;
  // No modifier: the page scrolls, as it would over any other part of the page. This is
  // the whole reason the gate exists — a map that ate the scroll would trap the reader.
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  wheelAcc += -e.deltaY * (e.deltaMode === 1 ? LINE_PX : 1);
  const steps = Math.trunc(wheelAcc / WHEEL_PER_ZOOM);
  if (!steps) return;
  // keep the remainder, so a slow pinch accumulates instead of being rounded away
  wheelAcc -= steps * WHEEL_PER_ZOOM;
  // AROUND THE POINTER, not the centre: you zoom towards the col you are looking at, and
  // re-centring on every step would walk the thing you're aiming at off the screen.
  map.setZoomAround(map.mouseEventToContainerPoint(e), map.getZoom() + steps);
}

/**
 * The map filling the window.
 *
 * A 320px strip is fine for reading the shape of a walk and poor for PLACING on it: at
 * whole-route zoom a day's leg is a couple of centimetres of switchbacks, and a fingertip
 * covers a mile of it. Expanding is what makes the tap accurate, so it belongs next to the
 * gesture rather than in a menu.
 *
 * A FIXED OVERLAY, not the Fullscreen API. Real fullscreen takes over the display and
 * leaves the page behind it unreachable — including the day rows this map is being placed
 * from — and it's the one browser mode where an escape hatch can be genuinely hard to
 * find on a laptop. A fixed panel keeps the app's own chrome available and the app's own
 * Escape working, which is what the overlay slot below is for.
 */
const expanded = ref(false);
/** The frame's element, so the animation can measure where the map actually is. */
const frameEl = ref<HTMLElement | null>(null);
/** The hole the frame leaves in the page while it is fixed, so nothing below it jumps. */
const parkedH = ref(0);
/** The animated clip. Null once a transition has settled, so nothing is clipped at rest. */
const clip = ref<string | null>(null);

// On the WINDOW, not the figure: Leaflet moves focus around inside its own container and
// a keydown on the map's SVG doesn't reliably reach an ancestor handler. Escape has to
// work wherever the focus happens to be, because it is the way out.
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") setExpanded(false);
}

/** Two frames, so the browser paints the starting value before the transition begins. */
const twoFrames = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** Where a given box sits, written as the clip that would reveal exactly it. */
function insetOf(r: DOMRect): string {
  const t = Math.round(r.top);
  const right = Math.round(window.innerWidth - r.right);
  const b = Math.round(window.innerHeight - r.bottom);
  const l = Math.round(r.left);
  return `inset(${t}px ${right}px ${b}px ${l}px round var(--radius-2))`;
}

/**
 * Open and close, as the map GROWING OUT OF ITS OWN PLACE on the page.
 *
 * Animated with a clip, not with width and height, and that is what makes it affordable:
 * the frame jumps to full size in one step, so Leaflet is told its new size exactly once,
 * and what moves is only the window we see it through. Animating the box instead would
 * mean re-measuring the map every frame — a burst of tile requests for a quarter-second of
 * motion, at a tile server we are a guest of.
 *
 * It also just reads better. The map is revealed rather than stretched, so the terrain
 * never distorts and the route never slides; it is the same picture, more of it.
 */
async function setExpanded(on: boolean) {
  if (on === expanded.value || !frameEl.value) return;
  const from = frameEl.value.getBoundingClientRect();

  if (on) {
    parkedH.value = Math.round(from.height);
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeydown);
    expanded.value = true;
    await nextTick();
    // full size FIRST, and told about it once
    map?.invalidateSize();
    // Re-frame only while the view is still ours. Someone who has zoomed into a col wants
    // that col bigger, not the whole route back.
    if (!touched) frame();
    clip.value = insetOf(from);
    await twoFrames();
    clip.value = "inset(0px round 0px)";
    return;
  }

  // CLOSING: the target is where the placeholder is standing NOW, not where the map was
  // when it opened. The page can be scrolled while the map is over it, and animating back
  // to a remembered rectangle would fly off to somewhere the map isn't.
  const back = parkedEl.value?.getBoundingClientRect();
  clip.value = back ? insetOf(back) : "inset(0px round 0px)";
  await new Promise<void>((r) => setTimeout(r, EXPAND_MS));
  expanded.value = false;
  clip.value = null;
  document.body.style.overflow = "";
  window.removeEventListener("keydown", onKeydown);
  await nextTick();
  map?.invalidateSize();
  if (!touched) frame();
}

/** Kept in step with the CSS below; a transitionend would miss the reduced-motion case,
 *  where the transition never runs and so never ends. */
const EXPAND_MS = 260;
const parkedEl = ref<HTMLElement | null>(null);

onBeforeUnmount(() => {
  document.body.style.overflow = "";
  window.removeEventListener("keydown", onKeydown);
});

/**
 * One pin's own controls, for when the rows are out of reach.
 *
 * Which is most of the time that matters: the map fills the window for placing, and the
 * day rows are behind it. Even on the page, going from a pin you can see to the row that
 * describes it means finding the right day first. Clicking the thing itself is the shorter
 * question, and it is the one everybody tries.
 *
 * Built as DOM rather than markup because Leaflet's popup takes an element or an HTML
 * STRING, and a waypoint's name is text somebody typed — `textContent` and `input.value`
 * can't be anything but text, where a template string is one missed escape from being
 * markup on a page anyone with the link can open.
 */
function pinPopup(w: { id: string; kind: string; alongM: number; label?: string }): HTMLElement {
  const meta = waypointKindMeta(w.kind);
  const root = document.createElement("div");
  root.className = "routemap__wp";

  const head = document.createElement("p");
  head.className = "routemap__wphead";
  const at = pointAlong(points.value, w.alongM);
  head.textContent = [
    meta.label,
    props.distanceUnit ? formatDistance(w.alongM, props.distanceUnit) : "",
    // the coordinate belongs here more than anywhere: this popup is what you have open
    // when you are copying a spring's position into something else
    at ? formatLatLon(at) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const input = document.createElement("input");
  input.className = "routemap__wpname";
  input.type = "text";
  input.maxLength = 120;
  input.value = w.label ?? "";
  input.placeholder = meta.label;
  input.setAttribute("aria-label", `Name for the ${meta.label.toLowerCase()}`);
  // on change, like every other name field in the app — never per keystroke, so a
  // half-typed word is not an op
  input.addEventListener("change", () => emit("rename", { id: w.id, label: input.value.trim() }));
  // Leaflet closes its popup on Escape and treats keys as map shortcuts; typing must not
  // reach it, or a name containing "-" starts zooming out
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") map?.closePopup();
  });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "routemap__wpdel";
  del.textContent = "Remove";
  del.addEventListener("click", () => {
    map?.closePopup();
    emit("remove", w.id);
  });

  root.append(head, input, del);
  return root;
}

async function draw() {
  if (!host.value) return;
  // Leaflet reads the container's size at construction. TrailPlanPanel lives behind a
  // v-if, so on the tick this mounts the element can still be zero-height — and a Leaflet
  // map built at zero height stays a grey box forever, since it never re-measures on its
  // own. nextTick, then invalidateSize, then watch the box for good.
  await nextTick();

  const [leaflet] = await Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]);
  L = leaflet.default ?? (leaflet as unknown as Leaflet);

  map = L.map(host.value, {
    // The map is inside a scrolling page. Wheel-zoom here would eat the page scroll every
    // time the cursor crossed it, so zooming is the buttons or a deliberate ctrl/⌘ + wheel
    // — which is `onWheel` below, because Leaflet's own handler has no modifier gate: it
    // is all scrolls or none. Off here, ours there.
    scrollWheelZoom: false,
    zoomControl: true,
    attributionControl: true,
  });

  // The caption under the map promised this and nothing delivered it: with Leaflet's
  // handler off, holding ⌘ did the same as not holding it, which is nothing.
  host.value.addEventListener("wheel", onWheel, { passive: false });

  // A VIEW BEFORE ANY LAYER. Leaflet's Map.addLayer returns early while `_loaded` is
  // false, deferring onAdd — so a layer added before the view exists has no DOM element
  // yet, and reading it back gets nothing. That failed silently: the route drew, in
  // Leaflet's default blue, because the per-day colours had nowhere to land.
  //
  // Days don't have to cover the whole route, so this frames the TRACK rather than the
  // legs — fitting to the legs would crop the ground nobody has planned yet.
  frame();

  // A walking map: contours, every stream, named glaciers and spurs, and the trails
  // themselves. See TILE_ORIGIN in nuxt.config.ts for the eight that were compared.
  //
  // NOTE THE AXIS ORDER: {z}/{x}/{y}, the OSM convention. ArcGIS services — including the
  // documented fallback — number tiles {z}/{y}/{x} instead, and swapped they still return
  // 200s, just tiles of somewhere else entirely.
  tiles = L.tileLayer(`${tileOrigin}/{z}/{x}/{y}.png`, {
    // The site sends `Referrer-Policy: no-referrer`, and this provider's usage policy
    // requires a valid Referer — an <img> never sends `Origin` either, so without this the
    // tiles are refused or we are silently in breach. "origin" sends `https://mahonia.app/`
    // and nothing more: no path, so no share code.
    referrerPolicy: "origin",
    // OpenTopoMap's own ceiling, and the cheapest way to stay a light user of free
    // community infrastructure — most tiles in a session come from zooming in, not panning.
    maxZoom: 17,
    // A licence requirement, not decoration. It must never be styled away.
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
      '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  });

  // If the tiles don't come — offline, or the provider having a bad day — drop them and
  // keep drawing. The geometry is ours; only the basemap is theirs, so the honest failure
  // is a route on plain ground rather than a blank rectangle or a grid of broken images.
  let misses = 0;
  tiles.on("tileerror", () => {
    if (++misses < 4 || !map || !tiles) return;
    map.removeLayer(tiles);
    tiles = null;
    failed.value = true;
  });
  tiles.addTo(map);

  renderLegs();
  
  renderPins();
  // AFTER the pins — on a loop it paints over the trailhead it shares a spot with
  renderFinish();
  // in case the pointer was already on the chart while the map was still loading
  renderTrace();
  renderBounds();

  // Any move that wasn't ours is theirs — drag, wheel, the +/− buttons, a keyboard arrow.
  // Watching the outcome rather than the input is what makes that list complete without
  // enumerating it.
  map.on("moveend zoomend", () => {
    if (!framing) touched = true;
  });

  // The chevrons are spaced in SCREEN pixels, so their spacing is only correct for the
  // zoom it was computed at — re-cut them whenever that changes. Zoom only: panning moves
  // them with the map, which Leaflet does itself.
  

  // PLACING. Bound to the map rather than to the legs, for two reasons: a 4px stroke is a
  // poor target on a phone, and the legs only cover days that have a distance typed — so
  // leg-only targets would leave the unplanned remainder of the route unclickable. The
  // click is projected onto the line, so a loose tap still lands where the route is.
  map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
    const range = props.armedRange;
    if (!range) return;
    // The pointerup that finishes a move generates a click here too. Without this, moving
    // a pin on an armed map dropped a second one on top of it.
    if (suppressPlace) return;
    // `lon`, not Leaflet's `lng` — the app's own LatLon shape
    const at = nearestAlongM(points.value, { lat: e.latlng.lat, lon: e.latlng.lng });
    // CLAMPED to the armed stretch. The affordance that armed this belongs to a day, so
    // the pin has to land in that day — a tap on a dimmed leg is a mis-tap, and pulling it
    // to the near end of the lit one is the forgiving reading rather than a refusal.
    emit("place", Math.min(range.toM, Math.max(range.fromM, at)));
  });

  map.invalidateSize();
  ro = new ResizeObserver(() => {
    if (!map) return;
    map.invalidateSize();
    // A map framed at one height is cropped at another, and this one is inside a panel
    // that opens, a page that reflows and a window that resizes. invalidateSize alone
    // keeps the centre and the zoom, so the route quietly loses its ends — re-frame while
    // the view is still ours.
    if (!touched) frame();
  });
  ro.observe(host.value);
}

onMounted(draw);

// Recut the legs when the itinerary changes. Only the lines are rebuilt, never the map —
// re-creating it would throw away the pan and zoom, which is the one piece of state here
// that belongs to the person looking at it.
watch(() => props.traceM, renderTrace);
watch(() => props.finishM, renderFinish);
// the finish redraws with them, so it stays on top of a trailhead it may be sharing a spot
// with — a re-added pin would otherwise paint over it
watch(() => props.waypoints, () => { renderPins(); renderFinish(); }, { deep: true });

watch(boundaries, renderBounds, { deep: true });

watch(dayLegs, () => {
  renderLegs();
  // the chevrons carry the day colours too, so they follow the same cut
  
});

// Arming lights ONE stretch and stands the rest down, so the legs have to be redrawn when
// it changes. Legs only — the chevrons keep their colours, because which way the route is
// walked is still true of the parts you are not aiming at.
watch(() => props.armedRange, renderLegs);

onBeforeUnmount(() => {
  ro?.disconnect();
  // ours, not Leaflet's — map.remove() only unbinds what Leaflet itself attached
  host.value?.removeEventListener("wheel", onWheel);
  map?.remove();
  map = null;
  legs = [];
  
  pins = [];
  bounds = [];
});
</script>

<template>
  <!--
    THE STATE CLASSES GO ON THE FIGURE, NEVER ON THE MAP CONTAINER — and this is not a
    style preference, it is the only shape that works.

    Vue patches a `:class` binding by writing the element's whole class attribute from
    what the template declares. Leaflet, meanwhile, adds SEVEN classes of its own to the
    container it initialises (`leaflet-container`, `leaflet-touch`, `leaflet-retina`, the
    grab and zoom ones) and its entire stylesheet is scoped under them. So a `:class` on
    that same element is fine until the moment it changes — at which point Vue rewrites
    the attribute, Leaflet's classes vanish, and every rule that positions the panes goes
    with them. The panes collapse to zero width, the reset's `max-width: 100%` then
    resolves against nothing, and the tiles and the route measure 0px wide.

    Which looked exactly like the map disappearing the instant you armed a waypoint.
  -->
  <figure
    class="routemap"
    :class="{ 'is-bare': failed, 'is-armed': !!armedRange, 'is-expanded': expanded }"
  >
    <!-- The frame is what anything floating over the map is positioned against. It has to
         be its own element: the FIGURE also contains the caption below, so a control
         anchored to the figure's bottom edge landed under the map rather than on it. -->
    <!-- The hole the frame leaves behind while it is fixed. Without it the page below
         jumps up the moment the map opens and drops back when it closes, which is the
         one motion the animation is trying not to have. -->
    <div v-if="expanded" class="routemap__parked" ref="parkedEl" :style="{ height: `${parkedH}px` }" aria-hidden="true" />
    <div ref="frameEl" class="routemap__frame" :style="clip ? { clipPath: clip } : undefined">
      <div ref="host" class="routemap__canvas" />
      <!-- The controls that have to stay reachable with the map over the page. Rendered
           only when expanded: below, the day rows are right there on the page and a second
           copy of their affordance would be two places to press for one thing. -->
      <div v-if="expanded" class="routemap__overlay">
        <slot name="overlay" />
      </div>
      <!-- TOP RIGHT, and the corner is not a free choice: Leaflet's zoom sits top left and
           its ATTRIBUTION sits bottom right. That attribution is a licence requirement —
           OpenStreetMap's data credit and OpenTopoMap's own — so it is the one thing on
           this map that must never be covered. Bottom left is the only other corner and
           it reads as an afterthought. -->
      <button
        type="button"
        class="routemap__expand"
        :aria-pressed="expanded"
        :aria-label="expanded ? 'Shrink the map back into the page' : 'Expand the map to fill the window'"
        :title="expanded ? 'Shrink the map' : 'Expand the map'"
        @click="setExpanded(!expanded)"
      >
        <HugeiconsIcon
          :icon="expanded ? ArrowShrink02Icon : ArrowExpand02Icon"
          :size="16"
          :stroke-width="2"
          aria-hidden="true"
        />
      </button>
    </div>
    <figcaption class="routemap__note">
      <!-- The FAILURE stays in the open. It is not an instruction you go looking for, it
           is the reason the picture under it looks wrong, and it has to arrive unasked. -->
      <span v-if="failed">Map tiles couldn't load — the route is still drawn.</span>
      <!-- The GESTURES fold into a (?), the same affordance the estimates use. Two
           sentences of instruction sat under the map permanently, and a caption you have
           read once is a caption you stop seeing while it goes on taking a line of the
           page. Behind a mark you can ask, they are there the day you need them.
           A real button, so touch and the keyboard reach it too — which matters more here
           than it does for the estimates, because one of the gestures it explains is the
           press-and-hold, and touch is exactly where that one is worth knowing. -->
      <Tooltip v-else :text="gestures" preferred-placement="top">
        <button type="button" class="btn btn--icon btn--ghost routemap__help" aria-label="How to use this map">
          <HugeiconsIcon :icon="HelpCircleIcon" :size="14" :stroke-width="2" />
        </button>
      </Tooltip>
    </figcaption>
  </figure>
</template>

<style lang="scss">
// NOT scoped: Leaflet builds its own DOM (panes, controls, the SVG the route is drawn
// into), and scoped styles can't reach elements Vue didn't render.

.routemap {
  margin: var(--space-4) 0 0;

  // The one place on the site where the theme does NOT flip.
  //
  // No free provider ships a dark topographic style, because hillshading and natural
  // terrain colour depend on a light surface — so the basemap is light in both themes and
  // the honest thing is to treat it as a PICTURE of ground, the way a photograph isn't
  // dark-moded either. (Never `filter: invert()`; terrain goes radioactive.)
  //
  // Which inverts the token rule for everything drawn on top: `--ink` is near-white in
  // dark mode and would vanish here, and the category hues lighten enough to wash out.
  // `color-scheme: light` makes every `light-dark()` below this node resolve to its light
  // branch — so the route keeps the exact colours the elevation chart uses, one
  // declaration, no parallel `--map-*` token set to keep in sync. This is the single
  // thing most likely to look right in development and break for every dark-mode user.
  color-scheme: light;
}

.routemap__canvas {
  height: 320px;
  width: 100%;
  // --radius-2, the same softening the app's other large surfaces take. Leaflet's own
  // container needs it too (below): the tile pane is transformed, and a transformed
  // descendant is not reliably clipped by an ancestor's rounded corners.
  border-radius: var(--radius-2);
  border: 1px solid var(--line-2);
  overflow: hidden;
  background: var(--paper-2);
  // Leaflet's panes stack on z-index 400+; keep the whole thing under the app's own
  // popovers and dialogs rather than letting a tile pane sit over a menu.
  z-index: 0;
  isolation: isolate;

}

.routemap {
  margin: 0;
}

// the anchor for anything drawn OVER the map — never the figure, which is taller
.routemap__frame {
  position: relative;
  display: flex;
}

/* EXPANDED: the map takes the window.
   Fixed rather than the Fullscreen API — see the comment on `expanded`. The z-index sits
   above the page and below nothing else the app puts up, because while this is open it IS
   the page. */
/* EXPANDED: the FRAME takes the window, and the figure stays exactly where it was.
   Fixing the figure instead pulled it out of flow and the whole page reflowed around it —
   see .routemap__parked. Fixed rather than the Fullscreen API; see `expanded`. */
.routemap.is-expanded .routemap__frame {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 100);
  padding: var(--space-3);
  background: var(--paper);
}
.routemap.is-expanded .routemap__canvas {
  height: auto;
}

/* The clip is what animates. See setExpanded: the frame is full size from the first frame,
   so Leaflet is measured once and only the window onto it moves. */
.routemap__frame {
  transition: clip-path var(--dur-map-expand) cubic-bezier(0.32, 0.72, 0, 1);
}
@media (prefers-reduced-motion: reduce) {
  .routemap__frame {
    transition: none;
  }
}
.routemap {
  // one place for the duration the script also counts on
  --dur-map-expand: 260ms;
}
.routemap__canvas {
  flex: 1;
  min-width: 0;
}
/* the caption is a footnote at strip size and a distraction at window size — the gesture
   it names still works, and by now you have used it */
.routemap.is-expanded .routemap__note {
  display: none;
}

/* The expanded map's own controls, floating over the terrain rather than pushing it down:
   the point of expanding is the map being big. */
/* The popup's own controls, kept plain — it is a name and a delete, over terrain. */
.routemap__wp {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.routemap__wphead {
  margin: 0;
  font-size: var(--text-chrome);
  color: #666;
}
.routemap__wpname {
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: 1px solid #ccc;
  border-radius: var(--radius-1);
  font: inherit;
  font-size: 1rem; // the iOS zoom floor, as .field has
  color: #111;
  background: #fff;
}
.routemap__wpdel {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: var(--text-chrome);
  // the one destructive control on the map, so it says so — every other mark here is ink
  // or a category hue, and this is neither
  color: var(--danger, #b3261e);
  cursor: pointer;
}
.routemap__wpdel:hover {
  text-decoration: underline;
}

.routemap__overlay {
  position: absolute;
  // clear of Leaflet's zoom buttons (top-left) and the expand button (top-right)
  left: 50%;
  translate: -50% 0;
  top: calc(var(--space-3) + var(--space-2));
  z-index: 500;
  max-width: calc(100% - 140px);
}

/* see the template for why this corner */
.routemap__expand {
  position: absolute;
  right: var(--space-2);
  top: var(--space-2);
  z-index: 500;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--line-2);
  border-radius: var(--radius-1);
  // Leaflet's own controls are white-on-map in both themes because the basemap stays
  // light; this matches them rather than the app's dark chrome.
  background: #fff;
  color: #333;
  cursor: pointer;
  box-shadow: 0 1px 4px #0000001f;
}
// Pointer-gated — it paints (see the note on .btn:hover, controls.scss). The control
// sits ON the map, so a latched grey square stayed visible over the tiles for the
// whole time you then spent panning around.
@media (hover: hover) and (pointer: fine) {
  .routemap__expand:hover {
    background: #f4f4f4;
  }
}

// tiles gone: plain ground, so the line is still readable
.routemap.is-bare .routemap__canvas {
  background: light-dark(oklch(0.95 0.01 250), oklch(0.95 0.01 250));
}

.routemap__note {
  margin-top: var(--space-1);
  font-size: var(--fs-xs);
  color: var(--ink-3);
}
/* The (?) sits where the sentence did, and quietly — it is an offer, not a notice. */
.routemap__help {
  color: var(--ink-3);
}

// ARMED: one stretch of the route is the only thing worth aiming at, so the cursor says
// so and everything else on the line stands down (see DIM). A deliberate mode rather than
// tap-anywhere, because the map is also a pan surface and a stray pin from a
// mis-registered drag would be maddening on touch.
//
// Descendant selector, not `.routemap__canvas.is-armed` — the class is on the figure. See
// the template for why it has to be.
.routemap.is-armed .routemap__canvas {
  cursor: crosshair;
}

// A TEARDROP, solid, with a shadow — and none of that is decoration.
//
// The disc-with-a-white-ring said "a thing is near here". A teardrop has a POINT, and the
// point is the answer: it lands on the metre of route the pin actually stores, where a
// circle only ever centred on it. That is why the anchor below moved to the tip.
//
// Solid rather than outlined, because the ring was doing the job a shadow does better. A
// 2px white halo separates a mark from the contour lines under it and nothing more; a
// shadow lifts it off the sheet, so the pin reads as sitting ON the terrain rather than
// being drawn into it. On a topographic basemap already full of thin coloured lines, that
// difference is what makes a pin findable without hunting.
.routemap__pin i {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  // WHITE, with the colour in the GLYPH.
  //
  // The other way round — a solid category hue with a white mark punched out — made the
  // pin a colour first and a thing second, and on a topographic sheet already carrying
  // magenta paths and green woodland that is one more coloured blob to sort out. A white
  // drop is the same shape on every ground, so what you actually read is the symbol: a
  // droplet means water before you have decided which blue it was. The hue is still there,
  // in the mark, doing the job of telling two water sources from two camps at a glance.
  background: #fff;
  color: var(--pin);
  position: relative;
  // round everywhere except the bottom-left, which the rotation below swings to the
  // bottom — one corner left square is the whole teardrop
  border-radius: 50% 50% 50% 0;
  rotate: -45deg;
  // the shadow is what lifts it off the sheet now that there is no ring; without one a
  // white drop on a pale contour is a hole rather than a pin
  box-shadow: -1px 1px 3px #00000059;
  transition:
    scale var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
// A LIGHT DISC UNDER THE MARK, filling the drop's round head.
//
// The white drop reads as one flat shape against pale ground — a contour sheet has plenty
// of near-white in it — and the glyph floats in the middle of it with nothing holding it.
// A quiet disc gives the mark a seat: it separates the symbol from the drop's own edge, and
// it puts a second tone in the pin so the head reads as round rather than as a blob with a
// point on it. Light enough that the white rim survives all the way round.
//
// No counter-rotation: a circle is the one shape the drop's -45° cannot disturb.
.routemap__pin i::before {
  content: "";
  position: absolute;
  inset: 14%;
  border-radius: 50%;
  background: #ececec;
}
// the drop is rotated, so the mark inside it has to be turned back or every glyph sits at
// 45° — a tent pitched on its side.
//
// `position: relative` is not cosmetic: the disc above is absolutely positioned, and a
// positioned element paints over a static sibling whatever the source order says. Without
// this the seat covers the mark it was meant to sit under.
.routemap__pin i > svg {
  position: relative;
  rotate: 45deg;
}
// LIFTED: the hold registered and the pin is now following the route.
// It has to be unmistakable — the whole risk of a press-and-hold is not knowing whether it
// took, and a pin that moves without ever looking picked up reads as a bug.
// HOVER: the drop grows a little. The whole job is answering "am I on it" before you
// press, which is the only thing a hover on a 30px target is asked. Smaller than the
// lifted state below, so picking one up still reads as a further step and not as more of
// the same.
.routemap__pin:hover i,
.routemap__bound:hover i {
  scale: 1.15;
}
.routemap__pin.is-lifted i {
  scale: 1.35;
  box-shadow: -2px 2px 8px #0000008c;
}
.routemap__pin {
  cursor: grab;
  // BROWSER scrolling only — Leaflet pans with its own JS handlers, so a drag that starts
  // on a pin still moves the map. What this stops is the page scrolling out from under a
  // hold, which would make the gesture impossible on a phone.
  touch-action: none;
}
.routemap__pin.is-lifted {
  cursor: grabbing;
}

/* A DAY BOUNDARY. Wears a tent, because that is what the end of a day is, and reads as a
   control rather than as data: paper-filled with an ink edge, where a waypoint is a solid
   category hue. One says "somebody put this here", the other says "your itinerary says
   this". Same lift gesture either way. */
.routemap__bound {
  background: none;
  border: 0;
  cursor: grab;
  touch-action: none;
}
// THE SAME DROP AS A WAYPOINT, because on the map it is one: the end of a day is a camp,
// and a reader shouldn't have to know which of these the itinerary drew and which somebody
// placed. What still separates them is the glyph's ink — a boundary is the itinerary
// talking, so it takes ink where a placed pin takes its category's hue.
.routemap__bound i {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  background: #1c1c1c;
  color: #fff;
  position: relative;
  border-radius: 50% 50% 50% 0;
  rotate: -45deg;
  box-shadow: -1px 1px 3px #00000059;
  transition:
    scale var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
// the same seat the waypoints wear — a camp is the same kind of mark on the map, so it
// gets the same construction and differs only by the ink of its glyph
.routemap__bound i::before {
  content: "";
  position: absolute;
  inset: 14%;
  border-radius: 50%;
  background: #333;
}

/* INVERTED: the itinerary's own marks, and the route's two ends.
   A white drop with a coloured glyph says "one of the things you will pass" — water, a
   landmark, a kind of place. These are not that. A camp is where the plan puts you and the
   ends are where the route begins and stops, and both are statements the ROUTE makes rather
   than categories of thing. Solid ink says so at a glance and needs no further hue, which
   matters on a sheet already carrying magenta paths and green woodland.
   The seat inverts with it — a step OFF the drop rather than a fixed grey, so the head
   still reads as round instead of as a black blob with a point on it. */
.routemap__pin--dark i {
  background: #1c1c1c;
  color: #fff;
}
.routemap__pin--dark i::before {
  background: #333;
}
.routemap__bound i > svg {
  // over the seat, not under it — see the waypoint pin for why this has to be positioned
  position: relative;
  rotate: 45deg;
}
.routemap__bound.is-lifted i {
  scale: 1.35;
  box-shadow: -2px 2px 8px #0000008c;
}
.routemap__bound.is-lifted {
  cursor: grabbing;
}
// Leaflet's divIcon ships a white box with a border; both are cleared or every pin
// renders inside a little card.
.routemap__pin {
  background: none;
  border: 0;
}

/* THE CHART'S CURSOR, ON THE GROUND.
   The same mark the profile draws at the same moment — ink with a paper ring — because it
   IS the same mark: one reading shown twice, once on the shape and once on the place. Made
   of the light-theme values rather than tokens, like everything else drawn over this
   basemap, which stays light in both themes.
   No transition. It follows a pointer, and easing a dot toward where the finger already is
   reads as lag rather than as polish. */
.routemap__trace {
  /* Leaflet's divIcon ships a white ground and a grey border — cleared here as it is for
     the pins, or the dot renders inside a little card. */
  border: 0;
  border-radius: 50%;
  background: #1c1c1c;
  /* the ring separates it from the day colour it sits on; the shadow lifts it off the
     contours, the same two jobs the pins' own casing does */
  box-shadow:
    0 0 0 2px #fff,
    0 1px 3px #00000059;
}

.routemap__leg,
.routemap__casing {
  // the day's colour arrives as inline style (see renderLegs); this is the shape of the mark
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.routemap__casing {
  // it exists to be under the colour, never to be hit — a click belongs to the leg on top
  pointer-events: none;
}

// Leaflet's own chrome, brought into the app's language. Attribution stays legible on
// purpose — it's a licence term, so it may be quiet but never hidden.
.routemap .leaflet-container {
  font: inherit;
  background: var(--paper-2);
  border-radius: var(--radius-2);
}

.routemap .leaflet-control-attribution {
  font-size: 10px;
  background: #ffffffcc;

  a {
    color: inherit;
  }
}

.routemap .leaflet-bar {
  border: 1px solid var(--line-2);
  box-shadow: none;

  a {
    color: var(--ink-2);
  }
}

@media print {
  // A map is the one mark here that can't survive losing its raster, and a page of grey
  // boxes is worse than a page without them.
  .routemap {
    display: none;
  }
}
</style>
