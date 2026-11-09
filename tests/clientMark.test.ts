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

  it("takes an app on this computer at its word for the logo, and still calls it unchecked", () => {
    expect(clientMark({ label: "Gemini CLI", kind: "registered" }, loopback)).toEqual({ name: "Gemini CLI", icon: GoogleGeminiIcon, initial: "G", checked: false });
    expect(clientMark({ label: "Codex", kind: "registered" }, loopback)).toMatchObject({ name: "Codex", icon: ChatGptIcon, checked: false });
    expect(clientMark({ label: "Visual Studio Code", kind: "registered" }, loopback)).toMatchObject({ icon: VisualStudioCodeIcon, checked: false });
    // a name that only contains a known one as part of a word doesn't count
    expect(clientMark({ label: "Claudette's packer", kind: "registered" }, loopback)).toMatchObject({ icon: null, initial: "C" });
  });

  it("never lets a name outrank a host it was checked against", () => {
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
