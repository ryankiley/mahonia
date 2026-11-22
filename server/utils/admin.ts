/** Whether an account may use the admin tools (verify_catalog_item): its id is listed
 *  in ADMIN_USER_IDS, comma-separated. Unset or empty is nobody, so a deploy that
 *  forgets the variable opens nothing. Read per call, so a changed value needs no
 *  restart. */
export function isAdmin(userId: number | null | undefined): boolean {
  if (!userId) return false;
  return (process.env.ADMIN_USER_IDS ?? "").split(",").some((id) => id.trim() !== "" && Number(id.trim()) === userId);
}
