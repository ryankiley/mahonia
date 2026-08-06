<script setup lang="ts">
import { dayColorSequence } from "~~/shared/categories";
import { decodePolyline, sliceAlong, type LatLon } from "~~/shared/polyline";

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
let ro: ResizeObserver | null = null;

const points = computed<LatLon[]>(() => decodePolyline(props.geometry));

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
  const colors = dayColorSequence(props.dayDistancesM.length);
  const out: { points: LatLon[]; color: string; day: number }[] = [];
  let run = 0;
  props.dayDistancesM.forEach((d, i) => {
    const leg = sliceAlong(points.value, run, run + d);
    run += d;
    if (leg.length >= 2) out.push({ points: leg, color: colors[i] ?? "var(--cat-other)", day: i + 1 });
  });
  return out;
});

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
  legs = dayLegs.value.map((leg) => {
    const line = L!.polyline(
      leg.points.map((p) => [p.lat, p.lon] as [number, number]),
      { weight: 4, opacity: 1, lineCap: "round", lineJoin: "round", className: "routemap__leg" },
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
    return line;
  });
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
    // time the cursor crossed it, so zooming is the buttons or a deliberate ctrl/⌘ + wheel.
    scrollWheelZoom: false,
    zoomControl: true,
    attributionControl: true,
  });

  // A VIEW BEFORE ANY LAYER. Leaflet's Map.addLayer returns early while `_loaded` is
  // false, deferring onAdd — so a layer added before the view exists has no DOM element
  // yet, and reading it back gets nothing. That failed silently: the route drew, in
  // Leaflet's default blue, because the per-day colours had nowhere to land.
  //
  // Days don't have to cover the whole route, so this frames the TRACK rather than the
  // legs — fitting to the legs would crop the ground nobody has planned yet.
  const all = points.value.map((p) => [p.lat, p.lon] as [number, number]);
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [16, 16] });
  else map.setView([0, 0], 2);

  // Hillshaded relief and nothing else — no roads, no labels, no place names. See
  // TILE_ORIGIN in nuxt.config.ts for why bare terrain beat a full topographic style.
  //
  // NOTE THE AXIS ORDER: this is an ArcGIS tile service, which numbers tiles {z}/{y}/{x},
  // the opposite of the OSM-style {z}/{x}/{y} every other provider uses. Swapped, it
  // still returns 200s — just tiles of somewhere else entirely.
  tiles = L.tileLayer(`${tileOrigin}/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}`, {
    // The site sends `Referrer-Policy: no-referrer`, and tile providers commonly use the
    // Referer to enforce their usage policy — an <img> never sends `Origin` either, so
    // without this the tiles can be refused. "origin" sends `https://mahonia.app/` and
    // nothing more: no path, so no share code.
    referrerPolicy: "origin",
    // The service itself goes to 23, but it is derived from a ~10–30 m elevation model,
    // so past here it is enlarging pixels rather than showing more ground. Stopping
    // where the data stops is also the cheapest way to stay a light user.
    maxZoom: 16,
    // A licence requirement, not decoration. It must never be styled away.
    attribution:
      'Terrain &copy; <a href="https://www.esri.com">Esri</a> — Sources: Esri, USGS, NASA, NGA, CGIAR',
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

  map.invalidateSize();
  ro = new ResizeObserver(() => map?.invalidateSize());
  ro.observe(host.value);
}

onMounted(draw);

// Recut the legs when the itinerary changes. Only the lines are rebuilt, never the map —
// re-creating it would throw away the pan and zoom, which is the one piece of state here
// that belongs to the person looking at it.
watch(dayLegs, renderLegs);

onBeforeUnmount(() => {
  ro?.disconnect();
  map?.remove();
  map = null;
  legs = [];
});
</script>

<template>
  <figure class="routemap">
    <div ref="host" class="routemap__canvas" :class="{ 'is-bare': failed }" />
    <figcaption class="routemap__note">
      <template v-if="failed">Map tiles couldn't load — the route is still drawn.</template>
      <template v-else>Hold ⌘ or Ctrl while scrolling to zoom.</template>
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

  // tiles gone: plain ground, so the line is still readable
  &.is-bare {
    background: light-dark(oklch(0.95 0.01 250), oklch(0.95 0.01 250));
  }
}

.routemap__note {
  margin-top: var(--space-1);
  font-size: var(--fs-xs);
  color: var(--ink-3);
}

.routemap__leg {
  // the day's colour arrives as inline style (see paint()); this is the shape of the mark
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
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
