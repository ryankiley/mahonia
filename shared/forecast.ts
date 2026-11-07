import type { LatLon } from "./polyline";

/**
 * Where a day's "Forecast" link goes: a link, never a fetch.
 *
 * A forecast is worth having the week before a trip and worthless on a list that outlives
 * it, so the app neither asks for one nor keeps one. It builds the URL of somebody else's
 * point forecast for the camp and lets the owner open it. Nothing leaves the browser until
 * they do, and then only the coordinate, rounded to three places (about 100 m, finer than
 * either site's grid, coarser than the route itself).
 *
 * Two sites by coverage. Inside the United States the National Weather Service's point
 * forecast is the one American hikers already read, made by the office that covers that
 * ground. Everywhere else yr.no (the Norwegian Meteorological Institute) takes a bare
 * coordinate and covers the whole planet. Neither needs a key.
 *
 * The US test is drawn INSIDE the border on purpose. A camp a few kilometres from Canada or
 * Mexico gets yr.no, which forecasts it fine; a point over the line sent to weather.gov would
 * get a page with no forecast on it. So every vertex below sits a few kilometres on the US
 * side of the line it follows, and the ocean sides run well out to sea, where nothing camps.
 */
export type ForecastSite = "weather.gov" | "yr.no";
export interface ForecastLink {
  href: string;
  site: ForecastSite;
}

// [lat, lon] around the lower 48, clockwise from the Pacific off Cape Flattery.
// prettier-ignore
const LOWER_48: readonly (readonly [number, number])[] = [
  // the 49th parallel, after dipping under Victoria and Point Roberts
  [48.2, -126], [48.2, -123.25], [48.99, -122.75], [48.99, -95.2],
  // Lake of the Woods, the Rainy River and the Boundary Waters
  [48.8, -95.1], [48.62, -94.6], [48.52, -93.4], [48.4, -92.7], [48.2, -92.1],
  [48.05, -91.3], [48, -90.6], [47.93, -89.7],
  // Lake Superior, south of Caribou Island and the Canadian shore (Isle Royale is its own box)
  [47.7, -89.4], [47.6, -87.8], [47.05, -85.9], [46.8, -84.9], [46.48, -84.62],
  // the St Marys River and Lake Huron
  [46.45, -84.4], [46.25, -84.15], [45.95, -83.7], [45.3, -82.6], [43.05, -82.5],
  // the St Clair River, Lake St Clair and the Detroit River
  [42.9, -82.48], [42.62, -82.58], [42.45, -82.86], [42.35, -83.06], [42.28, -83.14],
  [42.12, -83.2], [41.95, -83.3],
  // Lake Erie, under Pelee Island and Long Point
  [41.68, -83.05], [41.63, -82.7], [41.75, -82.2], [41.95, -81.5], [42.3, -80.1],
  [42.45, -79.6], [42.8, -78.95], [42.88, -78.87],
  // the Niagara River, Lake Ontario and the St Lawrence
  [43.1, -78.98], [43.3, -79], [43.45, -78], [43.55, -76.5], [43.95, -76.4],
  [44.1, -76.25], [44.28, -75.95], [44.62, -75.45], [44.9, -74.85], [44.97, -74.7],
  // the 45th parallel, then Maine's land border
  [44.97, -71.5], [45.2, -71.05], [45.35, -70.7], [45.75, -70.35], [46.2, -70.05],
  [46.6, -69.85], [47.3, -69.3], [47.1, -68.95], [47.15, -68.55], [47.1, -68.05],
  [46.95, -67.88], [45.95, -67.88], [45.55, -67.55], [45.15, -67.4], [44.95, -67.12],
  [44.8, -67.05], [44.6, -67.05], [44.2, -67.3],
  // out to sea down the Atlantic, round the Keys and across the Gulf
  [43.5, -68.5], [42.3, -69.7], [41.2, -69.7], [40.85, -71.8], [40.45, -73.6],
  [39.3, -74.2], [38.4, -74.8], [37, -75.5], [35.2, -75.3], [34.5, -76.3], [33.5, -78],
  [31.5, -80.5], [28.5, -80.3], [26.7, -79.95], [25.75, -80.05], [25.1, -80.25],
  [24.4, -80.7], [24.35, -82.2], [24.45, -83.1], [26, -83], [28.5, -83.4], [29.4, -84.4],
  [29.4, -86], [29.8, -88.3], [28.8, -89], [28.7, -90.5], [29, -93], [28.2, -95.5],
  [27.2, -97], [26, -96.9],
  // up the Rio Grande, round the Big Bend, to El Paso
  [26.03, -97.2], [26.15, -97.7], [26.28, -98.3], [26.48, -98.9], [26.65, -99.1],
  [27, -99.3], [27.55, -99.4], [28.75, -100.4], [29.4, -100.85], [29.88, -101.5],
  [30.05, -102.3], [29.55, -102.95], [29.25, -103.05], [29.05, -103.2], [29.15, -103.35],
  [29.22, -103.55], [29.33, -103.75], [29.65, -104.35], [30.25, -104.7], [30.85, -105.25],
  [31.35, -105.85], [31.62, -106.2], [31.83, -106.45],
  // the surveyed lines to the Pacific, and back up the coast
  [31.83, -106.65], [31.83, -108.15], [31.38, -108.15], [31.38, -111], [32.5, -114.65],
  [32.77, -114.75], [32.58, -117.1], [32.58, -117.4], [32.6, -119], [34, -121.5],
  [40, -125.5],
];

// The rest of the country NWS forecasts, as boxes with nobody else's land in them:
// [south, west, north, east]. Southeast Alaska's panhandle is left out — its border with
// British Columbia winds too much for a box — and gets yr.no.
// prettier-ignore
const BOXES: readonly (readonly [number, number, number, number])[] = [
  [54, -168, 71.5, -141.05], // mainland Alaska, west of the 141st meridian, short of the Diomedes
  [51, -180, 55.5, -159], // the Aleutians and the Alaska Peninsula
  [47.85, -89.25, 48.19, -88.4], // Isle Royale
  [18.5, -160.5, 22.5, -154.5], // Hawaii
  [17.8, -67.4, 18.6, -65.2], // Puerto Rico
];

/** Even-odd ray cast. Degrees as a plane is fine at this scale: the question is which side
 *  of a line a camp is on, and every line here is a few kilometres from the nearest one. */
function inPolygon(lat: number, lon: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [aLat, aLon] = poly[i]!;
    const [bLat, bLon] = poly[j]!;
    if (aLat > lat !== bLat > lat && lon < ((bLon - aLon) * (lat - aLat)) / (bLat - aLat) + aLon) inside = !inside;
  }
  return inside;
}

/** Whether weather.gov forecasts this point. False near a border, by design (see above). */
export function inNwsCoverage({ lat, lon }: LatLon): boolean {
  if (BOXES.some(([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e)) return true;
  return inPolygon(lat, lon, LOWER_48);
}

/** The forecast page for a point: weather.gov inside the US, yr.no everywhere else. */
export function forecastLink(p: LatLon): ForecastLink {
  const lat = p.lat.toFixed(3);
  const lon = p.lon.toFixed(3);
  return inNwsCoverage(p)
    ? { href: `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`, site: "weather.gov" }
    : { href: `https://www.yr.no/en/forecast/daily-table/${lat},${lon}`, site: "yr.no" };
}
