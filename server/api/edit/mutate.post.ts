import { createError, defineEventHandler, setHeader } from "h3";
import { applyOpsByEditToken } from "../../utils/listRepo";
import { requireEditToken } from "../../utils/auth";
import { readJsonBody } from "../../utils/http";
import { assertMaxBody, rateLimit } from "../../utils/rateLimit";
import type { Op } from "../../../shared/ops";

export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "mutate");
  assertMaxBody(event, 512_000);
  const token = requireEditToken(event);
  const body = await readJsonBody<{ ops?: Op[] }>(event);
  const ops = Array.isArray(body?.ops) ? body.ops.slice(0, 500) : [];
  if (!ops.length) throw createError({ statusCode: 400, statusMessage: "No ops" });

  const snapshot = await applyOpsByEditToken(token, ops);
  if (!snapshot) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { snapshot };
});
