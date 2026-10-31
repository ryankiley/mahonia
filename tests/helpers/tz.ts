/** Run `fn` with TZ pinned to each of four zones (UTC, a western one, the furthest
 *  eastern one, Tokyo), restoring it after. For the calendar-date code, whose whole
 *  reason to exist is that `new Date(iso)` is right in London and a day early in
 *  Portland; calendar, tripDays and tripDay each wrote this loop. */
export function inZones(fn: () => void) {
  const tz = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      fn();
    }
  } finally {
    process.env.TZ = tz;
  }
}
