<script setup lang="ts">
import { dayColorSequence } from "~~/shared/categories";
import { cumulativeM, decodePolyline, nearestAlongM, pointAlong, sliceAlong, type LatLon } from "~~/shared/polyline";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowExpand02Icon, ArrowShrink02Icon } from "@hugeicons/core-free-icons";
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
}>();

const emit = defineEmits<{ place: [alongM: number] }>();

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
let arrows: import("leaflet").Marker[] = [];
let pins: import("leaflet").Marker[] = [];
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

/** Whether a stretch of the route is outside the armed one, and so should stand down. */
function isDimmed(fromM: number, toM: number): boolean {
  const a = props.armedRange;
  return !!a && (toM <= a.fromM || fromM >= a.toM);
}

/**
 * How often a direction mark appears along the route.
 *
 * A line says where the walk goes and says nothing about which way round it is walked —
 * which on a LOOP is the entire question, because the two answers put your climb on
 * different days. So the route carries a few chevrons.
 *
 * FEW is the design. One every kilometre would trace the line in arrowheads and turn a
 * mark that reads as terrain into a mark that reads as a diagram, so the count is fixed
 * and the SPACING follows the route's length: about a dozen across whatever the route is,
 * never closer together than 1.5 km on a short one. A 64 km loop gets thirteen, a 6 km
 * afternoon gets two, and neither looks busy.
 */
const ARROW_COUNT = 13;
const ARROW_MIN_GAP_M = 1500;
/** How far either side of a chevron the heading is measured over. */
const ARROW_LOOK_M = 60;

/** The day that owns a given distance along the route, or -1 for ground no day claims. */
function dayAt(alongM: number): number {
  let run = 0;
  for (let i = 0; i < props.dayDistancesM.length; i++) {
    run += props.dayDistancesM[i]!;
    if (alongM <= run) return i;
  }
  return -1;
}

/**
 * The direction marks: position, screen angle, and the colour of the day they fall in.
 *
 * The angle is measured in LAYER space rather than from a compass bearing, which is both
 * simpler and exactly right — it asks Leaflet where these two points actually land on
 * screen, so it cannot disagree with the line it is sitting on whatever the projection is
 * doing. (Web Mercator is conformal, so the angle holds as you zoom; only Leaflet moving
 * the marker matters, and it does that itself.)
 */
function arrowMarks() {
  const line = points.value;
  if (!map || line.length < 2) return [];
  const total = cumulativeM(line).at(-1) ?? 0;
  if (!(total > 0)) return [];
  const gap = Math.max(total / ARROW_COUNT, ARROW_MIN_GAP_M);
  const out: { at: LatLon; deg: number; color: string }[] = [];
  // offset by half a gap so no chevron lands on the trailhead or the finish, where the
  // route's own end markers already are
  for (let d = gap / 2; d < total; d += gap) {
    const at = pointAlong(line, d);
    // A step either side, so the angle is the local direction of travel. Wide enough to
    // span a stored segment (~125 m at the simplification cap) rather than sampling inside
    // one, which would make the chevron chase a single switchback.
    const back = pointAlong(line, Math.max(0, d - ARROW_LOOK_M));
    const fwd = pointAlong(line, Math.min(total, d + ARROW_LOOK_M));
    if (!at || !back || !fwd) continue;
    // `project`, NOT `latLngToLayerPoint` — the latter rounds to whole pixels, and at
    // whole-route zoom these two points are a fraction of a pixel apart, so every angle
    // collapsed onto a multiple of 45°. The chevrons still pointed roughly the right way,
    // which is exactly why it would have survived a look.
    const a = map.project([back.lat, back.lon]);
    const b = map.project([fwd.lat, fwd.lon]);
    if (a.x === b.x && a.y === b.y) continue;
    const day = dayAt(d);
    out.push({
      at,
      // screen y grows downward, which is already what a CSS rotation expects
      deg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      color: day === -1 ? "var(--ink-3)" : (colors.value[day] ?? "var(--cat-other)"),
    });
  }
  return out;
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
 * Draw the direction marks.
 *
 * `interactive: false` matters: these sit ON the route, and a chevron that swallowed a
 * click would put a dead spot every few kilometres along the one thing you are meant to be
 * able to click.
 */
function renderArrows() {
  if (!map || !L) return;
  for (const m of arrows) m.remove();
  arrows = arrowMarks().map((mark) =>
    L!.marker([mark.at.lat, mark.at.lon], {
      interactive: false,
      keyboard: false,
      // The markup is entirely ours — no list content reaches it — so building it as a
      // string is safe here in a way it would not be for a waypoint's label.
      icon: L!.divIcon({
        className: "routemap__arrow",
        html: `<i style="transform:rotate(${mark.deg.toFixed(1)}deg);color:${mark.color}"></i>`,
        iconSize: [14, 14],
        // the CENTRE, not a pin's tip: the mark means "the route runs this way through
        // this point", so it has to sit on the line rather than hang off it
        iconAnchor: [7, 7],
      }),
    }).addTo(map!),
  );
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
/** The disc. Big enough to hold a legible glyph, small enough not to bury the terrain. */
const PIN_PX = 22;
const PIN_GLYPH_PX = 13;
const PIN_GLYPH_STROKE = 2.25;
function iconSvg(icon: unknown): string {
  const parts = (icon as [string, Record<string, string>][] | undefined) ?? [];
  const body = parts
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs ?? {})
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
 * Draw the pins.
 *
 * A waypoint stores only a DISTANCE, so its position is walked out of the polyline here —
 * which is the whole reason no coordinate is ever stored for one.
 *
 * The label goes on with textContent, never into the divIcon's html. That html is set as
 * innerHTML, and a label is text somebody typed on a list anyone with the link can open.
 */
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
        className: "routemap__pin",
        // The GLYPH inside the disc, not a bare dot. Five colours alone asked the reader
        // to hold a legend in their head that the map has nowhere to print — a droplet
        // says "water" without one, and it still says it to somebody who can't separate
        // the blue from the violet.
        html: `<i style="--pin:${meta.color}">${iconSvg(meta.icon)}</i>`,
        iconSize: [PIN_PX, PIN_PX],
        // the CENTRE: the pin means "this point on the line", so it sits ON it rather
        // than hanging off it the way a teardrop marker would
        iconAnchor: [PIN_PX / 2, PIN_PX / 2],
      }),
    }).addTo(map!);
    // The name if it has one, the KIND if it doesn't — an unnamed pin is the normal case
    // (three taps, three water sources), and "Water" beats an empty tooltip.
    marker.bindTooltip(document.createTextNode(w.label || meta.label) as never, { direction: "top" });
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
  // most wanted to look at. A white line under the colour keeps the route the loudest mark
  // on any ground, and costs one extra polyline per day.
  for (const leg of dayLegs.value) {
    legs.push(
      L!.polyline(
        leg.points.map((p) => [p.lat, p.lon] as [number, number]),
        {
          weight: 7,
          // the casing stands down WITH its leg, or a dimmed stretch reads as a white
          // line drawn over the terrain rather than as a quietened part of the route
          opacity: isDimmed(leg.fromM, leg.toM) ? DIM : 1,
          color: "#ffffff",
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
    if (el) el.style.stroke = leg.color;
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

// On the WINDOW, not the figure: Leaflet moves focus around inside its own container and
// a keydown on the map's SVG doesn't reliably reach an ancestor handler. Escape has to
// work wherever the focus happens to be, because it is the way out.
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") expanded.value = false;
}

watch(expanded, async (on) => {
  // the page behind must not scroll under the panel — a map you drag would otherwise take
  // the document with it the moment a gesture missed
  document.body.style.overflow = on ? "hidden" : "";
  if (on) window.addEventListener("keydown", onKeydown);
  else window.removeEventListener("keydown", onKeydown);
  await nextTick();
  if (!map) return;
  // Leaflet reads its container's size once. Going from a 320px strip to the whole window
  // without telling it leaves the tiles laid out for the old box: a quarter-covered map
  // with grey where the rest should be.
  map.invalidateSize();
  // Re-frame only while the view is still ours. Someone who has zoomed into a col wants
  // that col bigger, not the whole route back.
  if (!touched) frame();
});

onBeforeUnmount(() => {
  document.body.style.overflow = "";
  window.removeEventListener("keydown", onKeydown);
});

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
  renderArrows();
  renderPins();

  // Any move that wasn't ours is theirs — drag, wheel, the +/− buttons, a keyboard arrow.
  // Watching the outcome rather than the input is what makes that list complete without
  // enumerating it.
  map.on("moveend zoomend", () => {
    if (!framing) touched = true;
  });

  // PLACING. Bound to the map rather than to the legs, for two reasons: a 4px stroke is a
  // poor target on a phone, and the legs only cover days that have a distance typed — so
  // leg-only targets would leave the unplanned remainder of the route unclickable. The
  // click is projected onto the line, so a loose tap still lands where the route is.
  map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
    const range = props.armedRange;
    if (!range) return;
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
watch(() => props.waypoints, renderPins, { deep: true });

watch(dayLegs, () => {
  renderLegs();
  // the chevrons carry the day colours too, so they follow the same cut
  renderArrows();
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
  arrows = [];
  pins = [];
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
    <div ref="host" class="routemap__canvas" />
    <!-- The controls that have to stay reachable with the map over the page. Rendered
         only when expanded: below, the day rows are right there on the page and a second
         copy of their affordance would be two places to press for one thing. -->
    <div v-if="expanded" class="routemap__overlay">
      <slot name="overlay" />
    </div>
    <button
      type="button"
      class="routemap__expand"
      :aria-pressed="expanded"
      :aria-label="expanded ? 'Shrink the map back into the page' : 'Expand the map to fill the window'"
      :title="expanded ? 'Shrink the map' : 'Expand the map'"
      @click="expanded = !expanded"
    >
      <HugeiconsIcon
        :icon="expanded ? ArrowShrink02Icon : ArrowExpand02Icon"
        :size="16"
        :stroke-width="2"
        aria-hidden="true"
      />
    </button>
    <figcaption class="routemap__note">
      <span v-if="failed">Map tiles couldn't load — the route is still drawn.</span>
      <!-- The zoom hint is about a KEY, so it only exists where there are keys. It is
           hidden on a coarse pointer rather than dropped, because a touch laptop has
           both — and pinch works there whether or not the line is shown. The failure
           message above is not hidden with it: that one is true on every device. -->
      <span v-else class="routemap__hint">Hold ⌘ or Ctrl while scrolling to zoom.</span>
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
  // the anchor for the expand button and the overlay, which both sit over the canvas
  position: relative;
  margin: 0;
}

/* EXPANDED: the map takes the window.
   Fixed rather than the Fullscreen API — see the comment on `expanded`. The z-index sits
   above the page and below nothing else the app puts up, because while this is open it IS
   the page. */
.routemap.is-expanded {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 100);
  margin: 0;
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: var(--paper);
}
.routemap.is-expanded .routemap__canvas {
  flex: 1;
  height: auto;
}
/* the caption is a footnote at strip size and a distraction at window size — the gesture
   it names still works, and by now you have used it */
.routemap.is-expanded .routemap__note {
  display: none;
}

/* The expanded map's own controls, floating over the terrain rather than pushing it down:
   the point of expanding is the map being big. */
.routemap__overlay {
  position: absolute;
  // clear of Leaflet's zoom buttons (top-left) and the expand button (top-right)
  left: 50%;
  translate: -50% 0;
  top: calc(var(--space-3) + var(--space-2));
  z-index: 500;
  max-width: calc(100% - 140px);
}

/* Bottom-right: the two top corners are Leaflet's (zoom) and the bottom-left is the
   attribution, which is a licence requirement and must never be covered. */
.routemap__expand {
  position: absolute;
  right: var(--space-2);
  bottom: var(--space-2);
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
.routemap__expand:hover {
  background: #f4f4f4;
}
.routemap.is-expanded .routemap__expand {
  right: calc(var(--space-3) + var(--space-2));
  bottom: calc(var(--space-3) + var(--space-2));
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
/* Touch has no ⌘ and no wheel — the sentence names a gesture that does not exist there,
   and pinch-zoom needs no instructions. Removing the line also removes the caption's
   whole box on the surface with the least room for it. */
@media (pointer: coarse) {
  .routemap__hint {
    display: none;
  }
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

.routemap__pin i {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--pin);
  // the same white casing the route wears, for the same reason — a mark the colour of a
  // contour line is a mark nobody finds
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px #00000026;
  // the glyph reads as a hole punched in the disc; white against every category hue, and
  // white on ink for the route's two ends
  color: #fff;
}
// Leaflet's divIcon ships a white box with a border; both are cleared or every pin
// renders inside a little card.
.routemap__pin {
  background: none;
  border: 0;
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

// Which way round the walk goes.
//
// Leaflet's divIcon ships a white box with a border by default, which would put a little
// card behind every chevron; both are cleared here rather than fought with later.
.routemap__arrow {
  background: none;
  border: 0;
  // it sits ON the line, and the line is what you click to place a pin
  pointer-events: none;
}

// The chevron itself. No asset and no icon component — this chunk is already the heaviest
// thing the app lazy-loads — and it inherits `color`, so the day's colour arrives the same
// way the leg's does.
//
// A clip-path rather than the usual two-borders-rotated-45° trick, and that is a
// correctness choice rather than a stylistic one: this shape points along +x AS DRAWN, so
// the inline `transform` is the ONLY rotation involved. The border version needs a
// standing +45° correction, which has to live either in a second CSS property — `rotate`
// and `transform` are separate properties whose composition is easy to assume and hard to
// verify, and `getComputedStyle().transform` doesn't even report the pair — or as a magic
// number in the JavaScript. Both were wrong here before this: every chevron rendered at
// its own angle, none of them the route's.
.routemap__arrow i {
  display: block;
  width: 13px;
  height: 11px;
  margin: 1.5px 0.5px;
  background: currentcolor;
  clip-path: polygon(0 0, 100% 50%, 0 100%, 42% 50%);
  // a white halo, so a chevron stays legible where it sits on top of its own line rather
  // than merging into it. Flat white, not a token: the basemap under this never goes dark
  // (see color-scheme on .routemap), so there is no second case to answer for.
  filter: drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 1px #fff);
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
