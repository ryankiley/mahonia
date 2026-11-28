import type { AccountNotice } from "./useAccountModal";

// A sign-in link, from the moment its page loads to the moment you are back where you
// asked for it.
//
// WHERE ITS QUESTIONS ARE ASKED. A link opens in a fresh tab, on /auth/callback, with
// nothing in that tab before it. Its questions (is this account yours, do this
// browser's lists come too, it didn't work) were asked there, in a card over an empty
// page. But there IS a prior view: the page the link was asked from, which useReturnTo
// kept. So a question goes there first and is asked over it, like every other dialog in
// the app; with no page remembered (the link was asked for in another browser) it is
// the bare address's page, the list opened last.
//
// THE STRAIGHT RUN ASKS NOTHING, and stays in its order: sign in on the link's page,
// THEN go back, so the page you return to is mounted signed in. A list that opens
// through the account draws "can't open" for someone signed out and does not look
// again when a session appears, so going back first and signing in over it would leave
// it there. Only a question moves you first, and two of the three are asked with the
// sign-in already done or not possible here anyway.
//
// The dialog's reactive state is its own small file (useSignInLinkState), which is all
// AppOverlays reads; everything here is loaded with the link's page or the dialog. Called in
// the browser only (arrive, from the link page's onMounted).

type VerifyAnswer =
  | { ok: true; sweep: boolean }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "confirm"; email: string; asked: boolean };

// Not reactive, and not in the state the template can reach: the token is a credential,
// held only as long as there is something left to do with it.
let token = "";
/** the yes: sent with the token from then on, so a retry doesn't ask twice */
let confirmed = false;
/** how many times this link has been sent and failed with the network up */
let failures = 0;
/** The move to the prior view, once a question has made it: resolves true when that
 *  view was the page the link was asked from, false when it was the bare address.
 *  null until then, which is the straight run. */
let prior: Promise<boolean> | null = null;

export function useSignInLink() {
  const state = useSignInLinkState();
  const { refresh, allowListSweep } = useSession();

  const deviceLists = () => useMyLists().entries.value.filter(madeHere).length;

  /** The prior view, once: the page the link was asked from, or the bare address. */
  const toPriorView = () => (prior ??= useReturnTo().resume("/"));

  async function ask(question: typeof state.question): Promise<void> {
    state.question = question;
    // before the move, not after: the dialog's chunk then loads beside the page's
    state.everOpened = true;
    await toPriorView();
    state.open = true;
  }

  /** The card comes down, and with it the link: nothing is left to do with one. */
  function close(): void {
    state.open = false;
    token = "";
  }

  /** Hand the person to the thing they signed in for: back where they started if we
   *  still know, /gear if not (the one thing an account is for). The link usually
   *  returns in a new tab, which is why the return path is in localStorage. */
  async function finish(): Promise<void> {
    close();
    // the straight run: nothing was asked, so this is the one move
    if (!prior) await useReturnTo().resume("/gear");
    // asked over the bare address, because there was no page to go back to
    else if (!(await prior)) await navigateTo("/gear", { replace: true });
    // otherwise the question was asked over the page they came from: already there
  }

  /** A link with one way on, a new one, goes straight to the form that sends it: the
   *  account dialog, told why so it is titled for what happened. "expired" for a link
   *  that is spent, timed out or missing; "failed" for one that would not sign in. */
  async function newLink(why: AccountNotice): Promise<void> {
    close();
    await toPriorView();
    useAccountModal().open(why);
  }

  const browserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

  async function attempt(): Promise<void> {
    if (!token) return newLink("expired");
    // OFFLINE IS KNOWN BEFORE THE LINK IS SENT. The browser says when there is no
    // network, so the link is not thrown at a request that cannot leave: the card says
    // you're offline and the sign-in goes by itself when the connection is back
    // (SignInLinkDialog). It was sent anyway, failed, and was reported as a sign-in
    // that "couldn't" happen.
    if (browserOffline()) {
      state.offline = true;
      return ask("error");
    }
    state.busy = true;
    try {
      // The page's own session check went out as it loaded, and this is about to
      // change who is signed in: let that answer land first (sessionSettled says
      // what happened when it landed second).
      await sessionSettled();
      state.offline = false;
      const res = await $fetch<VerifyAnswer>("/api/auth/verify", {
        method: "POST",
        body: confirmed ? { token, confirmed } : { token },
      });
      if (!res.ok) {
        if (res.reason === "invalid") return await newLink("expired");
        state.asking = { email: res.email, asked: res.asked };
        return await ask("confirm");
      }
      // re-read the session so the rest of the app sees the new cookie
      await refresh(true);
      tally("sign_in");
      // THE LISTS ARE A SECOND QUESTION. A sign-in this browser asked for brings the
      // lists it made into the account (`sweep`). One that was only confirmed here
      // doesn't: the yes above is one press, and one press is what a stranger's link
      // is after, so it signs in and takes nothing with it. With no lists here there
      // is nothing to take and nothing to ask: what this browser makes from now on,
      // it makes signed in.
      if (!res.sweep) {
        if (deviceLists() > 0) return await ask("lists");
        await allowListSweep();
      }
      await finish();
    } catch {
      // network or rate limit — distinct from a bad token, and worth retrying
      state.offline = browserOffline();
      // ONE RETRY, THEN A NEW LINK. The card offered both at once, "Try again" over "Get
      // a new link", and nothing said how they differed: one sends the same link back
      // to the server, the other mails another. So the card has the one button, and a
      // second failure moves on by itself to the form for a new link. Failures offline
      // don't count: a new link cannot be asked for either, and trying again once the
      // network is back is the only thing that will ever work.
      if (!state.offline && ++failures >= 2) return await newLink("failed");
      await ask("error");
    } finally {
      state.busy = false;
    }
  }

  /** The link's page has loaded with this token ("" for none). Sent at once, with no
   *  click: for the person it is one tap from the email to being signed in. */
  async function arrive(fromLink: string): Promise<void> {
    token = fromLink;
    confirmed = false;
    failures = 0;
    prior = null;
    state.addFailed = false;
    await attempt();
  }

  /** Yes, this account is mine. The card stays up while the link goes back to the server
   *  (`busy` holds its buttons), and the answer closes or replaces it. */
  async function confirm(): Promise<void> {
    confirmed = true;
    await attempt();
  }

  async function addLists(): Promise<void> {
    state.busy = true;
    try {
      state.addFailed = !(await allowListSweep());
    } finally {
      state.busy = false;
    }
    if (!state.addFailed) await finish();
  }

  /** Escape, a press outside the card, and each question's own second button: the no.
   *  For the lists it is "carry on without"; for the others it leaves you on the page
   *  underneath with nothing signed in. */
  async function decline(): Promise<void> {
    if (state.question === "lists") return finish();
    close();
  }

  return { state, deviceLists, arrive, confirm, retry: attempt, addLists, decline };
}
