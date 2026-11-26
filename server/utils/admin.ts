/** The accounts that may use the admin tools (verify_catalog_item,
 *  get_catalog_edits and revert_catalog_edit): ADMIN_USER_IDS,
 *  comma-separated. Unset or empty is nobody, so a deploy that forgets the variable
 *  opens nothing. Read per call, but Vercel hands a deployment its environment when it
 *  is built: a value set or changed there reaches only the deployments made after it.
 *  An id is users.id, which the app never shows; read it in the database. */
function adminIds(): number[] {
  return (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "")
    .map(Number);
}

/** Whether an account is one of the admins. */
export function isAdmin(userId: number | null | undefined): boolean {
  if (!userId) return false;
  return adminIds().includes(userId);
}

/** Whether any account is an admin: when none is, no request needs its account looked
 *  up to know what to show it. */
export const anyAdmin = (): boolean => adminIds().length > 0;
