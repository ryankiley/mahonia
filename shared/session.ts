/**
 * A readable, non-authorizing session marker. It selects account-scoped browser
 * caches; the HttpOnly session cookie remains the only credential. Its value is a
 * short hex string derived from the session (server/utils/authSession
 * sessionOwnerMarker), never an id: a fresh sign-in gets a fresh one.
 */
export const SESSION_OWNER_COOKIE = "mh_session_owner";

/** What a marker looks like. Read out of a cookie anyone can edit, so it's checked
 *  before it becomes part of a storage key; the real ones are 16 hex characters. */
export const SESSION_OWNER_PATTERN = /^[0-9a-f]{1,64}$/;
