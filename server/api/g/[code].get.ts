import { defineEventHandler, getRouterParam } from "h3";
import { openPrivate } from "../../utils/authSession";
import { useVaultDb } from "../../utils/db";
import { notFound } from "../../utils/http";
import { sharedGearByCode } from "../../utils/vaultShare";

// The read-only view of someone's My Gear, by its link code. Read capability only.
//
// NEVER CACHED, unlike a list's /api/s/{code}: the owner was promised the link stops
// working the moment they turn it off, and an edge copy would keep answering for its
// window. So each view is one small read, under the same per-IP budget as a list share.
export default defineEventHandler(async (event) => {
  await openPrivate(event, "public-read");
  const gear = await sharedGearByCode(await useVaultDb(), getRouterParam(event, "code") || "");
  if (!gear) throw notFound();
  return gear;
});
