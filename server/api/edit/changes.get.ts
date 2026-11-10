import { defineEventHandler, getQuery } from "h3";
import { getByEditHash, versionByEditHash } from "../../utils/listRepo";
import { requireEdit } from "../../utils/editAuth";
import { notFound } from "../../utils/http";

// Live-sync poll for the editor. Returns the full snapshot only when the
// server version is newer than the client's `since` (small lists → cheap).
export default defineEventHandler(async (event) => {
  const hash = await requireEdit(event, "poll");
  const since = Number(getQuery(event).since) || 0;

  const version = await versionByEditHash(hash);
  if (version === null) throw notFound();
  if (version <= since) return { version };
  return { version, snapshot: await getByEditHash(hash) };
});
