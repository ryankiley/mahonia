import { createError, defineEventHandler, setHeader } from "h3";
import { applyOpsByEditToken } from "../../utils/listRepo";
import { requireEditToken } from "../../utils/auth";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import type { Op } from "../../../shared/ops";

export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "mutate");
  const token = requireEditToken(event);
  const body = await readJsonBodyCapped<{ ops?: Op[] }>(event, 512_000);
  const ops = Array.isArray(body?.ops) ? body.ops : [];
  if (!ops.length) throw createError({ statusCode: 400, statusMessage: "No ops" });
  // Reject oversized batches loudly — never slice. A silent truncation would drop
  // the tail ops and the client would then adopt the truncated snapshot as
  // authoritative (permanent data loss after an offline-accumulated queue). This
  // cap is a deliberately roomy BACKSTOP, not the client contract: the current
  // flush() chunks its pending queue into <=500-op requests, but an already-
  // deployed (service-worker-cached) client predating that change still sends its
  // whole queue in one request — 4000 lets those drain instead of looping on 400,
  // and anything larger hits the 512KB body cap above anyway (~60-150 B/op).
  if (ops.length > 4000) throw createError({ statusCode: 400, statusMessage: "Too many ops" });

  const snapshot = await applyOpsByEditToken(token, ops);
  if (!snapshot) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { snapshot };
});
