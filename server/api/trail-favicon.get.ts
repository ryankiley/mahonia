import { defineEventHandler, getQuery, setHeader } from "h3";
import { useDb } from "../utils/db";
import { faviconForUrl } from "../utils/trailFavicon";
import { rateLimit } from "../utils/rateLimit";
import { setNoIndex } from "../utils/http";

// A trail site's favicon, by URL. Exists because the EDITOR needs one before a list has
// a server row: a draft holds its trail link on-device, and the browser can't fetch a
// third-party icon itself (CSP is `default-src 'self'` / `img-src 'self' data: blob:`).
// So the client asks us, and we answer with an inlined data: URL that the CSP allows.
//
// The saved-list path doesn't come through here — attachTrailFavicon joins the cached
// row straight into the snapshot. This is the unsaved case only.
//
// Never an error: an unknown or hostile host answers { dataUrl: null } and the link just
// renders its globe. A favicon is decoration and must not produce a failure state.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  // this endpoint reaches OUT to a caller-named host, so it's rate-limited harder than a
  // plain read — the per-host cache means a real user hits the network once a month
  await rateLimit(event, "trail-favicon");

  const raw = getQuery(event).url;
  if (typeof raw !== "string") return { dataUrl: null };

  const db = await useDb();
  // one call: it returns the cached icon on the common path, and only reaches the
  // network for a host nobody has linked yet (writing a negative row if that fails, so
  // a dead host isn't refetched on the next keystroke). It swallows its own errors.
  const dataUrl = await faviconForUrl(db, raw);

  // the icon for a given host is the same for everyone and changes about never — let the
  // edge answer this so a popular trail site costs one origin hit a day
  setHeader(event, "Cache-Control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
  return { dataUrl };
});
