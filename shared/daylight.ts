// Daylight — how much light a calendar day has at a place, from the Sun's position.
//
// Pure arithmetic: a coordinate and a `YYYY-MM-DD` in, hours of daylight out. No
// network, no timezone. The Trip tab estimates how long a day's walk takes; this says
// how much light there is to walk it in, and both come from what a list already holds
// once a route file is imported (the geometry) and the dates are set. Nothing is
// fetched, which is the posture the whole map feature keeps (config/security.ts).
//
// ── THE EQUATIONS ──────────────────────────────────────────────────────────────
//
// NOAA's solar calculator, which is Jean Meeus's "Astronomical Algorithms" (1991)
// reduced to the low-precision series: the Sun's mean longitude and anomaly as
// polynomials in Julian centuries from J2000, the equation of centre, the apparent
// longitude (aberration and nutation folded in), the obliquity of the ecliptic, and
// from those the declination. Sunrise and sunset are where the Sun's centre stands
// 0.833° below the horizon: 0.5667° of atmospheric refraction plus its 0.2667°
// semidiameter, so the moment the upper limb appears rather than the centre. That is
// the convention every published sunrise table uses, and why a day at the equator is
// 12 h 7 min rather than exactly twelve. Good to about a minute; the series holds
// that for a few centuries either side of 2000.
//
// DURATION ONLY, deliberately. The length of a day needs no timezone: it is twice the
// hour angle at sunrise, and an hour angle is a fraction of the Earth's turn. Clock
// times for sunrise and sunset would need the zone the coordinate is in, and a
// coordinate does not carry one (a longitude gives a solar offset, not a political
// zone). Rather than guess, this gives the number that needs no guessing.

import { utcMidnight } from "./calendar";
import type { LatLon } from "./polyline";

const DEG = Math.PI / 180;
/** the horizon for sunrise: refraction (0.5667°) plus the Sun's semidiameter (0.2667°) */
const SUNRISE_ZENITH_DEG = 90.833;
/** the Julian day at 2000-01-01T12:00Z, the epoch the series count from */
const J2000 = 2451545.0;
/** the Julian day at the Unix epoch, 1970-01-01T00:00Z */
const JD_UNIX_EPOCH = 2440587.5;
const DAY_MS = 86_400_000;

/**
 * The Sun's declination, in degrees, at a Julian day. Positive north: about +23.44°
 * at the June solstice, −23.44° at the December one, zero at the equinoxes.
 */
export function solarDeclinationDeg(julianDay: number): number {
  const t = (julianDay - J2000) / 36525; // Julian centuries from J2000
  const meanLongitude = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = (357.52911 + t * (35999.05029 - 0.0001537 * t)) * DEG;
  const centre =
    Math.sin(meanAnomaly) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly) * 0.000289;
  const trueLongitude = meanLongitude + centre;
  const omega = (125.04 - 1934.136 * t) * DEG;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega);
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega);
  return Math.asin(Math.sin(obliquity * DEG) * Math.sin(apparentLongitude * DEG)) / DEG;
}

/**
 * Hours of daylight at a place on a calendar day: from the Sun's upper limb rising to
 * it setting. 0 in polar night, 24 under a midnight sun. Null for a string that isn't
 * a date, so a caller can decline rather than compute on garbage.
 *
 * Evaluated at the place's own solar noon rather than at noon in Greenwich: the
 * declination moves up to 0.4° a day, and a place twelve hours from Greenwich would
 * otherwise be read half a day off. Under a minute of daylight either way, but it's
 * the honest reading and it costs a subtraction.
 */
export function daylightHours(at: LatLon, iso: string): number | null {
  const ms = utcMidnight(iso);
  if (Number.isNaN(ms)) return null;
  // this date's noon in Greenwich, moved to the place's own noon: a degree of
  // longitude is 1/360 of a day, and the Sun reaches the east first
  const jd = ms / DAY_MS + JD_UNIX_EPOCH + 0.5 - at.lon / 360;
  const decl = solarDeclinationDeg(jd) * DEG;
  const lat = at.lat * DEG;
  const cosHourAngle =
    Math.cos(SUNRISE_ZENITH_DEG * DEG) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
  if (cosHourAngle >= 1) return 0; // the Sun never clears the horizon
  if (cosHourAngle <= -1) return 24; // …or never dips below it
  const hourAngleDeg = Math.acos(cosHourAngle) / DEG;
  return (2 * hourAngleDeg) / 15;
}

/**
 * The margin a walking estimate has to leave before the light runs out, in hours.
 *
 * Two, because the walking figure is moving time only (no breaks, no camp chores) and
 * is itself good to about ±20%: a day that walks up to its last hour of light is one
 * that finishes in the dark for many of the people who will walk it. Pitching a tent
 * by headlamp is the thing this exists to flag a week beforehand.
 */
export const DAYLIGHT_MARGIN_H = 2;

/** True when the walking estimate runs past the day's light, less the margin. */
export function lightIsShort(walkingHours: number | undefined, daylight: number | null | undefined): boolean {
  if (walkingHours == null || daylight == null) return false;
  return walkingHours > daylight - DAYLIGHT_MARGIN_H;
}

/**
 * "15 h 41 min", to the minute. Not a band like the walking estimate's: this figure
 * is arithmetic on a date and a place, and rounding it would hide precision it has.
 */
export function formatDaylight(hours: number): string {
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
