import { createError, defineEventHandler, setHeader } from "h3";
import { listSnapshotsByEditHash } from "../../utils/listRepo";
import { requireEditHash } from "../../utils/editAuth";
import { rateLimit } from "../../utils/rateLimit";

// List a list's recovery points (vandalism recovery for the shared-edit model).
// Capability-gated (see editAuth); 404 when the capability doesn't resolve (no
// existence oracle).
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "snapshots");
  const hash = await requireEditHash(event);
  const snapshots = await listSnapshotsByEditHash(hash);
  if (!snapshots) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { snapshots };
});
