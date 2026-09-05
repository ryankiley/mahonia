import { createError, defineEventHandler } from "h3";
import { createList } from "../../utils/listRepo";
import { readJsonBodyCapped, setNoIndex } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { resolveSession } from "../../utils/authSession";
import { pickListMeta, type ListData, type ListMeta } from "../../../shared/types";

export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "create");
  const body = await readJsonBodyCapped<Partial<ListMeta> & { data?: ListData }>(event, 512_000);

  // The list's WHOLE meta rides the create. A draft can carry a title, a unit, a trail
  // link with its distance and route, and trip dates before it exists server-side, and
  // each of those used to be a hand-written line here that, when missing, silently
  // dropped the field the moment the draft was first saved (trip dates were the one
  // missed). A JSON-backup restore arrives by the same door. pickListMeta walks
  // LIST_META_KEYS, so a meta field added there reaches this route on its own.
  // Validation is createList's — field by field, typeof included — and this route
  // holds no second copy of those rules; the one shape check left is the content's.
  const meta = pickListMeta(body ?? {});
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
    const { editToken, snapshot } = await createList({ ...meta, data, authorUserId: author?.id });
    return { editToken, snapshot };
  } catch (e) {
    console.error("[create list]", e);
    throw createError({ statusCode: 500, statusMessage: "Could not create list" });
  }
});
