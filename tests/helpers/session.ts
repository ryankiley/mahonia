// The account suites' sign-in: a real startSession over a bare H3 event, read back
// as the cookie a browser would replay. sessionLifecycle, editAuthGate and
// passkeyCeremony each wrote it before it lived here.

import { SESSION_COOKIE, startSession } from "../../server/utils/authSession";
import type { TestDb } from "./db";
import { makeEvent, setCookieValue } from "./http";

/** Sign `userId` in and hand back the raw session token and the Cookie header
 *  value (`session=<token>`) that replays it. */
export async function signInCookie(db: TestDb, userId: number): Promise<{ token: string; cookie: string }> {
  const event = makeEvent("/");
  await startSession(event, db, userId);
  const token = setCookieValue(event, SESSION_COOKIE);
  if (!token) throw new Error("startSession set no session cookie");
  return { token, cookie: `${SESSION_COOKIE}=${token}` };
}

/** The credential half of a stored passkey — a base64 public key, a fresh counter,
 *  discoverable. A suite adds the user and the credential id it is about. */
export const PASSKEY = { publicKey: "cHVibGlj", counter: 0, discoverable: true } as const;
