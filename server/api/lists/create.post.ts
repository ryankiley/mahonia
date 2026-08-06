import { createError, defineEventHandler, setHeader } from "h3";
import { createList } from "../../utils/listRepo";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { resolveSession } from "../../utils/authSession";
import type { ListData, Unit } from "../../../shared/types";
import { UNITS } from "../../../shared/types";

export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "create");
  const body = await readJsonBodyCapped<{
    title?: string;
    description?: string;
    displayUnit?: Unit;
    trailUrl?: string;
    trailLabel?: string;
    trailDistanceM?: number;
    trailDistanceUnit?: string;
    trailProfile?: string;
    trailAscentM?: number;
    bodyWeightG?: number;
    bodyWeightUnit?: string;
    startDate?: string;
    endDate?: string;
    data?: ListData;
  }>(event, 512_000);

  const title = typeof body?.title === "string" ? body.title.slice(0, 200) : undefined;
  // set on a JSON-backup restore, so the description survives the round-trip
  const description =
    typeof body?.description === "string" && body.description
      ? body.description.slice(0, 4000)
      : undefined;
  const displayUnit =
    body?.displayUnit && UNITS.includes(body.displayUnit) ? body.displayUnit : undefined;
  // A trail link can be set on a DRAFT, before the list exists server-side — without
  // these it would be silently dropped the moment the draft is first saved. (createList
  // re-validates the URL; passing it through raw here is safe.)
  const trailUrl = typeof body?.trailUrl === "string" ? body.trailUrl : undefined;
  const trailLabel = typeof body?.trailLabel === "string" ? body.trailLabel : undefined;
  // and the route's length with them — same draft, same row, same silent loss without it
  const trailDistanceM = typeof body?.trailDistanceM === "number" ? body.trailDistanceM : undefined;
  const trailDistanceUnit =
    typeof body?.trailDistanceUnit === "string" ? body.trailDistanceUnit : undefined;
  // the route's shape and the walker, set on a DRAFT before the list exists server-side —
  // without these they are silently lost the moment that draft is first saved
  const trailProfile = typeof body?.trailProfile === "string" ? body.trailProfile : undefined;
  const trailAscentM = typeof body?.trailAscentM === "number" ? body.trailAscentM : undefined;
  const bodyWeightG = typeof body?.bodyWeightG === "number" ? body.bodyWeightG : undefined;
  const bodyWeightUnit =
    typeof body?.bodyWeightUnit === "string" ? body.bodyWeightUnit : undefined;
  // Trip dates are the same case exactly: set from the same meta row, on the same
  // draft, and likewise dropped on first save without this. Also the restore half of
  // a JSON backup. (createList validates them; raw is fine here too.)
  const startDate = typeof body?.startDate === "string" ? body.startDate : undefined;
  const endDate = typeof body?.endDate === "string" ? body.endDate : undefined;
  const data =
    body?.data && Array.isArray(body.data.folders) && Array.isArray(body.data.items)
      ? body.data
      : undefined;

  // Stamp the maker, if there is one. Best-effort and deliberately non-fatal: a
  // list is still made by someone with no account at all, and a session lookup
  // that fails must not cost them the list. Stamped ONCE here and never re-pointed
  // — see createList's authorUserId for why claiming can't rewrite authorship.
  const author = await resolveSession(event).catch(() => null);

  try {
    const { editToken, snapshot } = await createList({
      authorUserId: author?.id,
      title,
      description,
      displayUnit,
      trailUrl,
      trailLabel,
      trailDistanceM,
      trailDistanceUnit,
      trailProfile,
      trailAscentM,
      bodyWeightG,
      bodyWeightUnit,
      startDate,
      endDate,
      data,
    });
    return { editToken, snapshot };
  } catch (e) {
    console.error("[create list]", e);
    throw createError({ statusCode: 500, statusMessage: "Could not create list" });
  }
});
