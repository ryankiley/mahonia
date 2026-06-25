import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { applyOpsByEditToken } from "../../utils/listRepo";
import { requireEditToken } from "../../utils/auth";
import { assertMaxBody, rateLimit } from "../../utils/rateLimit";
import type { Op } from "../../../shared/ops";

export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  rateLimit(event, "mutate", 300, 60_000);
  assertMaxBody(event, 512_000);
  const token = requireEditToken(event);
  const body = (await readBody(event).catch(() => ({}))) as { ops?: Op[] };
  const ops = Array.isArray(body?.ops) ? body.ops.slice(0, 500) : [];
  if (!ops.length) throw createError({ statusCode: 400, statusMessage: "No ops" });

  const snapshot = await applyOpsByEditToken(token, ops);
  if (!snapshot) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { snapshot };
});
