import { describe, expect, it } from "vitest";
import { ChatGptIcon, ClaudeIcon, GoogleGeminiIcon, VisualStudioCodeIcon } from "@hugeicons/core-free-icons";
import { clientMark } from "../app/utils/clientMark";

const https = (host: string) => ({ host, loopback: false });
const loopback = { host: "127.0.0.1:33418", loopback: true };

describe("clientMark", () => {
  it("names Claude from its metadata document's host, wherever the answer goes", () => {
    for (const back of [https("claude.ai"), loopback]) {
      expect(clientMark({ label: "claude.ai", kind: "document" }, back)).toMatchObject({ name: "Claude", icon: ClaudeIcon, checked: true });
    }
  });

  it("names a registered app from the https host its answer goes to, not from what it calls itself", () => {
    expect(clientMark({ label: "Totally ChatGPT", kind: "registered" }, https("chatgpt.com"))).toMatchObject({ name: "ChatGPT", icon: ChatGptIcon, checked: true });
    expect(clientMark({ label: "Visual Studio Code", kind: "registered" }, https("insiders.vscode.dev"))).toMatchObject({ name: "VS Code", icon: VisualStudioCodeIcon });
    expect(clientMark({ label: "Gemini", kind: "registered" }, https("gemini.google.com"))).toMatchObject({ name: "Gemini", icon: GoogleGeminiIcon });
    // Gemini is its own host, not the rest of Google
    expect(clientMark({ label: "Gemini", kind: "registered" }, https("docs.google.com"))).toMatchObject({ icon: null, checked: false });
  });

  it("never draws a logo for a name an app gave itself", () => {
    // back to this computer: the name is all there is
    expect(clientMark({ label: "ChatGPT", kind: "registered" }, loopback)).toEqual({ name: "ChatGPT", icon: null, initial: "C", checked: false });
    // a known name pointed at somebody else's site
    expect(clientMark({ label: "Claude", kind: "registered" }, https("claude.ai.example.net"))).toMatchObject({ name: "Claude", icon: null, checked: false });
    // a metadata document on a lookalike host
    expect(clientMark({ label: "notclaude.ai", kind: "document" }, https("notclaude.ai"))).toMatchObject({ name: "notclaude.ai", icon: null, initial: "N", checked: true });
  });

  it("letters the tile from the first letter or digit of the name", () => {
    expect(clientMark({ label: "a registered app", kind: "registered" }, loopback).initial).toBe("A");
    expect(clientMark({ label: "  [beta] tool", kind: "registered" }, loopback).initial).toBe("B");
    expect(clientMark({ label: "—", kind: "registered" }, loopback).initial).toBe("?");
  });
});
