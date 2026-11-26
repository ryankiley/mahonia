import { reactive } from "vue";

// The sign-in link dialog's state, and NOTHING ELSE, on purpose. app.vue reads
// `everOpened` to decide whether to mount the dialog, and app.vue is on every page's
// first load: whatever this file imports arrives with it. The link's logic
// (useSignInLink) pulls in the session, the list registry and the return path, so it
// lives next door and is loaded only by the two things that run it, the link's own page
// and the dialog. The same split useAccountModal, useFeedback and useDialogs keep.
//
// Module-level, and under their rule: mutated in the browser only, so the server renders
// it closed for everyone.

/** what the dialog is asking: whose account this is, whether this browser's lists come
 *  along, or what to do about a sign-in that failed */
type LinkQuestion = "confirm" | "lists" | "error";

const state = reactive({
  open: false,
  everOpened: false,
  question: "error" as LinkQuestion,
  /** what the server said when it wanted a yes: whose account, and whether any browser
   *  asked for this link */
  asking: { email: "", asked: true },
  /** the link, or the lists, are with the server */
  busy: false,
  /** there is no network: the card is a wait and not a failure */
  offline: false,
  addFailed: false,
});

export const useSignInLinkState = () => state;
