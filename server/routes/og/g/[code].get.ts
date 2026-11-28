import { defineEventHandler, getRouterParam } from "h3";
import { gearCardModel } from "../../../../shared/ogGearCard";
import { useDb } from "../../../utils/db";
import { notFound, setNoIndex } from "../../../utils/http";
import { sendOgCardModel } from "../../../utils/ogCard";
import { rateLimit } from "../../../utils/rateLimit";
import { sharedGearByCode } from "../../../utils/vaultShare";

// The social-card image for a shared My Gear link: what /g/[code]'s og:image points at.
// Same read capability as the page, and shows nothing the page doesn't (the counts and
// the owner's chosen name, from the same fail-closed read). Never cached, as the page
// isn't: a link turned off takes its card with it, rather than leaving a copy at the edge.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "public-read");
  const gear = await sharedGearByCode(await useDb(), getRouterParam(event, "code") || "");
  if (!gear) throw notFound();
  return sendOgCardModel(event, gearCardModel(gear), "none");
});
