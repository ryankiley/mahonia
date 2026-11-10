import { ChatGptIcon, ClaudeIcon, CubeIcon, GoogleGeminiIcon, MistralIcon, PerplexityAiIcon, VisualStudioCodeIcon } from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";

// Who the /authorize page says is asking, and which logo goes on its tile.
//
// Where Mahonia has a host it has CHECKED, the host decides, and the app's own name
// can't overrule it:
//   - when the answer goes back over https, the code lands on that host and nowhere
//     else, so the host is who gets the access, whichever kind of client asked
//     (ChatGPT's callback is chatgpt.com; Claude's is claude.ai; Cursor's agents and
//     VS Code for the web come back to their own sites too). A metadata document's
//     host doesn't outrank it: a document may list any https callback, and one served
//     from some page on a known domain would otherwise wear that maker's name while
//     the code went elsewhere;
//   - when it comes back to this computer, a client metadata document's host is the
//     one checked thing left: it was fetched over https from there (Claude Code comes
//     in this way, from claude.ai).
// A known host gets our name for the app and its logo. Any other host gets the app's
// own name and its initial, even when that name is "Claude": a name pointed at
// somebody else's site is contradicted by the one thing that was checked.
//
// An app that comes back to a port on this computer (Cursor and VS Code on the
// desktop, Gemini CLI, Codex) leaves no host to check, so it is taken at its word:
// a name that matches a known app gets that app's logo (Ryan, 2026-11-09: Gemini CLI
// should wear the spark). It keeps its own name, and `checked` stays false, so the
// page still says the app named itself and that any program here could be listening.
//
// The domains are the makers' own, so an entry can only ever miss, never name the
// wrong party. Claude, ChatGPT, Cursor and VS Code are the callbacks those clients
// document; Gemini, Mistral and Perplexity are their domains, with no published callback
// to check against yet. Gemini is its app's own host, never all of google.com.
const KNOWN: readonly { name: string; icon: IconNode; domains: readonly string[]; called: RegExp }[] = [
  { name: "Claude", icon: ClaudeIcon, domains: ["claude.ai", "claude.com"], called: /\bclaude\b/i },
  // the OpenAI knot, which Codex wears too
  { name: "ChatGPT", icon: ChatGptIcon, domains: ["chatgpt.com"], called: /\b(chatgpt|codex|openai)\b/i },
  // the cube Cursor's logo is drawn as, the same one its button wears on /account
  { name: "Cursor", icon: CubeIcon, domains: ["cursor.com"], called: /\bcursor\b/i },
  { name: "VS Code", icon: VisualStudioCodeIcon, domains: ["vscode.dev"], called: /\b(vs ?code|visual studio code)\b/i },
  // the four-point spark
  { name: "Gemini", icon: GoogleGeminiIcon, domains: ["gemini.google.com"], called: /\bgemini\b/i },
  { name: "Le Chat", icon: MistralIcon, domains: ["mistral.ai"], called: /\b(mistral|le chat)\b/i },
  { name: "Perplexity", icon: PerplexityAiIcon, domains: ["perplexity.ai"], called: /\bperplexity\b/i },
];

export interface AskingClient {
  label: string;
  kind: "document" | "registered";
}
export interface ReturnTo {
  host: string;
  loopback: boolean;
}
export interface ClientMark {
  /** what the page calls it: ours for a known host, else the app's own label */
  name: string;
  /** a logo: a known host's, or for an app on this computer, the one its name matches */
  icon: IconNode | null;
  /** the tile's letter when there is no logo */
  initial: string;
  /** whether the name came from a checked host rather than from the app itself */
  checked: boolean;
}

const bare = (host: string) => host.replace(/:\d+$/, "").toLowerCase();
const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function clientMark(client: AskingClient, returnTo: ReturnTo): ClientMark {
  // a metadata document's label is the host it was fetched from
  const docHost = client.kind === "document" ? bare(client.label) : null;
  // the host Mahonia has checked for this request, if there is one
  const host = returnTo.loopback ? docHost : bare(returnTo.host);
  const byHost = host ? KNOWN.find((k) => k.domains.some((d) => under(host, d))) : undefined;
  // only where there is no host to go by — a checked host that isn't the app's own
  // outranks whatever it calls itself
  const byName = host ? undefined : KNOWN.find((k) => k.called.test(client.label));
  const name = byHost?.name ?? client.label;
  return {
    name,
    icon: (byHost ?? byName)?.icon ?? null,
    initial: name.replace(/^[^\p{L}\p{N}]+/u, "").charAt(0).toUpperCase() || "?",
    // a document names itself by its host; that name stands only where the code goes
    // back to that same host or to this computer
    checked: !!byHost || (docHost !== null && host === docHost),
  };
}
