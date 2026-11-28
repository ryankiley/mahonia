// How long the nightly cron keeps a list, in days. In shared/ because the server
// enforces these (listRepo's reap and purge) and the privacy policy and help page
// state them, and the published numbers have to be the ones that run.

/** A list with one item or none is soft-deleted after this many days untouched. */
export const LIST_REAP_STALE_DAYS = 30;

/** A soft-deleted list is kept this many days before it is deleted for good. */
export const LIST_PURGE_GRACE_DAYS = 90;
