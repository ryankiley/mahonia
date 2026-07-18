import { createError, defineEventHandler, setHeader } from "h3";
import { createList } from "../../utils/listRepo";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import type { ListData, Unit } from "../../../shared/types";
import { UNITS } from "../../../shared/types";

export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "create");
  const body = await readJsonBodyCapped<{
    title?: string;
    description?: string;
    displayUnit?: Unit;
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
  const data =
    body?.data && Array.isArray(body.data.folders) && Array.isArray(body.data.items)
      ? body.data
      : undefined;

  try {
    const { editToken, snapshot } = await createList({ title, description, displayUnit, data });
    return { editToken, snapshot };
  } catch (e) {
    console.error("[create list]", e);
    throw createError({ statusCode: 500, statusMessage: "Could not create list" });
  }
});
