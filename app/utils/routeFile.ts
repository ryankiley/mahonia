// What a route-file picker offers, and what a failed read says: the Trip tab's and /trail-spin's.
// Here, not beside the reader (shared/gpx.ts, readRouteFile), because the editor loads the
// reader on demand and a failed load still has to say something.
//
// The accept list only decides what the system's picker shows as choosable: the reader
// sniffs a file's content and never trusts its name.
//
// It ends in application/octet-stream for the iPhone. iOS turns the list into its own file
// types and greys out every file it can't match, and a .gpx, .tcx or .fit has no type there
// unless some installed app declares one: on a phone without a hiking app, the Trip tab and
// /trail-spin couldn't pick a GPX at all (found in the iOS Simulator, 2026-11-28). Such a file
// is plain data to iOS, which octet-stream admits; the reader still turns away anything that
// isn't a route, with ROUTE_FILE_UNREADABLE.
export const ROUTE_FILE_ACCEPT =
  ".gpx,.kml,.kmz,.tcx,.fit,.geojson,.json,.xml,application/gpx+xml,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/vnd.ant.fit,application/geo+json,application/json,text/xml,application/octet-stream";

export const ROUTE_FILE_TOO_BIG = "That file is too big to read here.";
export const ROUTE_FILE_UNREADABLE = "Couldn’t read a route out of that file.";
