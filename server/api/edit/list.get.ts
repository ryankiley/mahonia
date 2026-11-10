import { defineEventHandler } from "h3";
import { getByEditHash } from "../../utils/listRepo";
import { requireEdit } from "../../utils/editAuth";
import { notFound } from "../../utils/http";

export default defineEventHandler(async (event) => {
  const hash = await requireEdit(event, "poll");
  const snapshot = await getByEditHash(hash);
  if (!snapshot) throw notFound();
  return { snapshot };
});
