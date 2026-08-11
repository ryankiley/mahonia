import { defineEventHandler, getQuery } from "h3";
import { getByEditHash, versionByEditHash } from "../../utils/listRepo";
import { requireEditHash } from "../../utils/editAuth";
import { rateLimit } from "../../utils/rateLimit";
import { notFound, setNoIndex } from "../../utils/http";

// Live-sync poll for the editor. Returns the full snapshot only when the
// server version is newer than the client's `since` (small lists → cheap).
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  // throttle first: requireEditHash only proves a capability was PRESENTED, so an
  // unresolvable one would otherwise drive an unthrottled DB lookup per request
  await rateLimit(event, "poll");
  const hash = await requireEditHash(event);
  const since = Number(getQuery(event).since) || 0;

  const version = await versionByEditHash(hash);
  if (version === null) throw notFound();
  if (version <= since) return { version };
  return { version, snapshot: await getByEditHash(hash) };
});
