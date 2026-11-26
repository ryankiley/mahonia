// copyTextWhen: copying a link that the same click is still making. The whole reason
// it exists is ORDER — the clipboard write has to begin inside the click, before the
// list's save has answered, or Safari refuses it — so that order is what's asserted,
// along with the two ways down from it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextWhen } from "~/utils/clipboard";

// What a browser's ClipboardItem holds: the promise it was handed, per type.
class FakeClipboardItem {
  constructor(public data: Record<string, Promise<Blob>>) {}
}

function stubClipboard(over: { write?: (items: FakeClipboardItem[]) => Promise<void>; writeText?: (t: string) => Promise<void> }) {
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: over });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyTextWhen", () => {
  it("starts the write before the text exists, and hands it the text as a promise", async () => {
    let written = "";
    const write = vi.fn(async (items: FakeClipboardItem[]) => {
      written = await (await items[0]!.data["text/plain"]!).text();
    });
    stubClipboard({ write });
    let arrive!: (t: string) => void;
    const text = new Promise<string>((resolve) => (arrive = resolve));

    const done = copyTextWhen(text);
    expect(write).toHaveBeenCalledOnce(); // inside the click, the link not yet made
    arrive("https://mahonia.app/s/NEWLIST00001");

    expect(await done).toBe(true);
    expect(written).toBe("https://mahonia.app/s/NEWLIST00001");
  });

  it("waits and copies the plain way where the promised write is refused", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard({ write: async () => Promise.reject(new DOMException("no", "NotAllowedError")), writeText });
    expect(await copyTextWhen(Promise.resolve("https://mahonia.app/s/X"))).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://mahonia.app/s/X");
  });

  it("is false, with no rejection left over, when the write is refused AND the text never arrives", async () => {
    stubClipboard({ write: async () => Promise.reject(new DOMException("no", "NotAllowedError")), writeText: async () => {} });
    expect(await copyTextWhen(Promise.reject(new Error("not saved")))).toBe(false);
    await new Promise((r) => setTimeout(r)); // an unhandled rejection would fail the run here
  });

  it("is false, and writes nothing, when the text never arrives", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard({ write: async (items) => void (await items[0]!.data["text/plain"]), writeText });
    expect(await copyTextWhen(Promise.reject(new Error("not saved")))).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
