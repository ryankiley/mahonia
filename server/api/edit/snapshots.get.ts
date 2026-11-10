import { defineEventHandler } from "h3";
import { listSnapshotsByEditHash } from "../../utils/listRepo";
import { requireEdit } from "../../utils/editAuth";
import { resolveSession } from "../../utils/authSession";
import { notFound, setPrivate } from "../../utils/http";

// List a list's recovery points (vandalism recovery for the shared-edit model).
// Capability-gated (see editAuth); 404 when the capability doesn't resolve (no
// existence oracle).
//
// The answer depends on who's asking (your own changes read "You"), so it is never
// cached for anyone else.
export default defineEventHandler(async (event) => {
  setPrivate(event);
  const hash = await requireEdit(event, "snapshots");
  const viewer = await resolveSession(event).catch(() => null);
  const snapshots = await listSnapshotsByEditHash(hash, undefined, viewer?.id ?? null);
  if (!snapshots) throw notFound();
  return { snapshots };
});
