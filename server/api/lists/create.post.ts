import { createError, defineEventHandler } from "h3";
import { createList } from "../../utils/listRepo";
import { readJsonBody } from "../../utils/http";
import { assertMaxBody, rateLimit } from "../../utils/rateLimit";
import type { ListData, Unit } from "../../../shared/types";
import { UNITS } from "../../../shared/types";

export default defineEventHandler(async (event) => {
  await rateLimit(event, "create", 30, 60_000);
  assertMaxBody(event, 512_000);
  const body = await readJsonBody<{
    title?: string;
    displayUnit?: Unit;
    data?: ListData;
  }>(event);

  const title = typeof body?.title === "string" ? body.title.slice(0, 200) : undefined;
  const displayUnit =
    body?.displayUnit && UNITS.includes(body.displayUnit) ? body.displayUnit : undefined;
  const data =
    body?.data && Array.isArray(body.data.folders) && Array.isArray(body.data.items)
      ? body.data
      : undefined;

  try {
    const { editToken, snapshot } = await createList({ title, displayUnit, data });
    return { editToken, snapshot };
  } catch (e) {
    console.error("[create list]", e);
    throw createError({ statusCode: 500, statusMessage: "Could not create list" });
  }
});
