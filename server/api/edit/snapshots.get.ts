import { defineEventHandler } from "h3";
import { listSnapshotsByEditHash } from "../../utils/listRepo";
import { requireEditHash } from "../../utils/editAuth";
import { rateLimit } from "../../utils/rateLimit";
import { notFound, setNoIndex } from "../../utils/http";

// List a list's recovery points (vandalism recovery for the shared-edit model).
// Capability-gated (see editAuth); 404 when the capability doesn't resolve (no
// existence oracle).
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "snapshots");
  const hash = await requireEditHash(event);
  const snapshots = await listSnapshotsByEditHash(hash);
  if (!snapshots) throw notFound();
  return { snapshots };
});
