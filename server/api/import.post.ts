import { createError, defineEventHandler, setHeader } from "h3";
import { csvToListData } from "../../shared/exporters/csv";
import { lighterpackId } from "../../shared/lighterpack";
import { readJsonBody } from "../utils/http";
import { assertMaxBody, rateLimit } from "../utils/rateLimit";

// Import a LighterPack shared list by URL. We ONLY ever fetch lighterpack.com's
// sanctioned CSV export (/csv/{id}) — the HOST is hardcoded, never user-supplied
// (see shared/lighterpack.ts), so there's no SSRF surface; only the external-id
// path segment comes from the user's URL, charset-constrained. Returns parsed
// ListData; the client creates the list via /api/lists/create (same path as the
// CSV/file import).
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "import");
  assertMaxBody(event, 4_000);
  const body = await readJsonBody<{ url?: string }>(event);
  const id = lighterpackId(typeof body?.url === "string" ? body.url : "");
  if (!id) throw createError({ statusCode: 400, statusMessage: "Not a LighterPack share link" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let csv: string;
  try {
    const res = await fetch(`https://lighterpack.com/csv/${id}`, {
      signal: controller.signal,
      redirect: "error", // /csv responds directly — no redirects to follow (no escape hatch)
      headers: { accept: "text/csv,text/plain,*/*" },
    });
    if (!res.ok) throw createError({ statusCode: 404, statusMessage: "LighterPack list not found" });
    const text = await res.text();
    if (text.length > 512_000) throw createError({ statusCode: 413, statusMessage: "List too large" });
    csv = text;
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode) throw e;
    throw createError({ statusCode: 502, statusMessage: "Couldn’t reach LighterPack" });
  } finally {
    clearTimeout(timer);
  }

  const data = csvToListData(csv);
  if (!data.items.length) throw createError({ statusCode: 422, statusMessage: "No items found in that list" });
  return { data };
});
