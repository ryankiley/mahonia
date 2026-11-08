import { describe, expect, it } from "vitest";
import { forecastLink, inNwsCoverage } from "~~/shared/forecast";

const at = (lat: number, lon: number) => ({ lat, lon });

describe("which forecast a camp links to", () => {
  // Places people actually walk, including the ones that sit close to a border.
  it.each([
    ["Yosemite Valley", 37.745, -119.588],
    ["Mount Whitney", 36.578, -118.292],
    ["Paradise, Mount Rainier", 46.786, -121.735],
    ["Enchanted Valley, Olympic", 47.68, -123.38],
    ["Cascade Pass, North Cascades", 48.475, -121.075],
    ["Many Glacier", 48.797, -113.658],
    ["Goat Haunt, three kilometres from Canada", 48.96, -113.89],
    ["Phantom Ranch", 36.105, -112.095],
    ["Chisos Basin, Big Bend", 29.27, -103.3],
    ["the South Rim, Big Bend", 29.21, -103.3],
    ["Ely, at the Boundary Waters", 47.9, -91.87],
    ["Rock Harbor, Isle Royale", 48.145, -88.485],
    ["the Keweenaw", 47.47, -87.89],
    ["Mount Marcy", 44.112, -73.924],
    ["Mount Washington", 44.27, -71.303],
    ["Katahdin", 45.904, -68.921],
    ["Springer Mountain", 34.627, -84.194],
    ["Clingmans Dome", 35.563, -83.498],
    ["Flamingo, Everglades", 25.141, -80.924],
    ["Key West", 24.555, -81.78],
    ["Denali", 63.73, -148.92],
    ["Kilauea", 19.42, -155.29],
    ["El Yunque", 18.3, -65.79],
  ])("%s gets weather.gov", (_, lat, lon) => {
    expect(inNwsCoverage(at(lat, lon))).toBe(true);
  });

  it.each([
    ["Vancouver", 49.283, -123.121],
    ["Victoria, south of the 49th", 48.428, -123.365],
    ["Banff", 51.178, -115.571],
    ["Thunder Bay", 48.38, -89.25],
    ["Sault Ste. Marie, Ontario", 46.52, -84.33],
    ["Windsor, south of Detroit", 42.317, -83.037],
    ["Pelee Island", 41.77, -82.65],
    ["Toronto", 43.653, -79.383],
    ["Montreal", 45.5, -73.57],
    ["Campobello Island", 44.88, -66.95],
    ["Tijuana", 32.514, -117.038],
    ["Mexicali", 32.624, -115.454],
    ["Ciudad Juárez", 31.69, -106.42],
    ["Boquillas del Carmen, across from Big Bend", 29.183, -102.925],
    ["Nuevo Laredo", 27.476, -99.516],
    ["Matamoros", 25.869, -97.504],
    ["Bimini", 25.73, -79.28],
    ["Havana", 23.11, -82.37],
    ["Whitehorse", 60.72, -135.06],
    ["Big Diomede", 65.78, -169.05],
    ["Chamonix", 45.92, 6.87],
  ])("%s gets yr.no", (_, lat, lon) => {
    expect(inNwsCoverage(at(lat, lon))).toBe(false);
  });

  // The line is drawn a few kilometres inside the border, so a camp ON the border gets the
  // global forecast rather than risking a weather.gov page with nothing on it. That is the
  // trade, and these are the cases it costs.
  it.each([
    ["the PCT's southern terminus, at the wall", 32.59, -116.467],
    ["Juneau, in the panhandle's winding border", 58.3, -134.42],
  ])("%s gets yr.no, by design", (_, lat, lon) => {
    expect(inNwsCoverage(at(lat, lon))).toBe(false);
  });
});

describe("the forecast URL", () => {
  it("is a weather.gov point forecast inside the US", () => {
    expect(forecastLink(at(37.74512, -119.58831))).toEqual({
      href: "https://forecast.weather.gov/MapClick.php?lat=37.745&lon=-119.588",
      site: "weather.gov",
    });
  });

  it("is a yr.no coordinate page elsewhere", () => {
    expect(forecastLink(at(45.92372, 6.86951))).toEqual({
      href: "https://www.yr.no/en/forecast/daily-table/45.924,6.870",
      site: "yr.no",
    });
  });

  it("sends three decimal places and no more", () => {
    const { href } = forecastLink(at(-44.6714159, 167.9262539));
    expect(href).toBe("https://www.yr.no/en/forecast/daily-table/-44.671,167.926");
  });
});
