import { ChatGptIcon, ClaudeIcon, CubeIcon, GoogleGeminiIcon, MistralIcon, PerplexityAiIcon, VisualStudioCodeIcon } from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";

// Who the /authorize page says is asking, and whether it may draw their logo.
//
// A logo goes only on a host Mahonia has CHECKED, never on a name an app gave itself:
//   - a client metadata document was fetched over https from its host, so the host is
//     the client (Claude's apps, web and Code alike, come in this way from claude.ai);
//   - a registered app named itself, but when the answer goes back over https, the
//     code lands on that host and nowhere else, so the host is who gets the access
//     (ChatGPT's callback is chatgpt.com; Cursor's agents and VS Code for the web
//     come back to their own sites too).
// An app that comes back to a port on this computer (Cursor and VS Code on the
// desktop, Gemini CLI, Codex) can only be what it says it is, and any program here
// could say the same. It keeps its own name, gets its first letter on the tile, and
// the page's warning still runs.
//
// The domains are the makers' own, so an entry can only ever miss, never name the
// wrong party. Claude, ChatGPT, Cursor and VS Code are the callbacks those clients
// document; Gemini, Mistral and Perplexity are their domains, with no published callback
// to check against yet. Gemini is its app's own host, never all of google.com.
const KNOWN: readonly { name: string; icon: IconNode; domains: readonly string[] }[] = [
  { name: "Claude", icon: ClaudeIcon, domains: ["claude.ai", "claude.com"] },
  { name: "ChatGPT", icon: ChatGptIcon, domains: ["chatgpt.com"] },
  // the cube Cursor's logo is drawn as, the same one its button wears on /account
  { name: "Cursor", icon: CubeIcon, domains: ["cursor.com"] },
  { name: "VS Code", icon: VisualStudioCodeIcon, domains: ["vscode.dev"] },
  // the four-point spark
  { name: "Gemini", icon: GoogleGeminiIcon, domains: ["gemini.google.com"] },
  { name: "Le Chat", icon: MistralIcon, domains: ["mistral.ai"] },
  { name: "Perplexity", icon: PerplexityAiIcon, domains: ["perplexity.ai"] },
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
  /** what the page calls it: ours for a known app, else the server's label */
  name: string;
  /** a logo, only for a known app on a checked host */
  icon: IconNode | null;
  /** the tile's letter when there is no logo */
  initial: string;
  /** whether the name came from a checked host rather than from the app itself */
  checked: boolean;
}

/** the host Mahonia has checked for this request, if there is one */
function checkedHost(client: AskingClient, returnTo: ReturnTo): string | null {
  if (client.kind === "document") return client.label;
  if (!returnTo.loopback) return returnTo.host.replace(/:\d+$/, "");
  return null;
}

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function clientMark(client: AskingClient, returnTo: ReturnTo): ClientMark {
  const host = checkedHost(client, returnTo)?.toLowerCase() ?? null;
  const known = host ? KNOWN.find((k) => k.domains.some((d) => under(host, d))) : undefined;
  const name = known?.name ?? client.label;
  return {
    name,
    icon: known?.icon ?? null,
    initial: name.replace(/^[^\p{L}\p{N}]+/u, "").charAt(0).toUpperCase() || "?",
    checked: !!known || client.kind === "document",
  };
}
