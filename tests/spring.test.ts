// A spring's duration, read back off the stylesheet. The token is written in
// milliseconds (`--spring-step-dur: 390ms`) and that is what a dev build serves, but a
// production build's minifier rewrites it to the shorter `.39s` — and a bare parseFloat
// then read 0.39 as milliseconds: truthy, so the fallback never fired and every
// JS-timed spring (a row's fold, the mode switch's row heights, the map's close) ran in
// under a millisecond. The reader has to honour the unit it is given.
import { describe, expect, it } from "vitest";
import { cssDurationMs } from "../app/utils/spring";

describe("cssDurationMs — a CSS time, in milliseconds", () => {
  const FALLBACK = 123;

  it("reads milliseconds as written", () => {
    expect(cssDurationMs("390ms", FALLBACK)).toBe(390);
  });

  it("reads seconds, the form a minifier ships", () => {
    expect(cssDurationMs(".39s", FALLBACK)).toBe(390);
    expect(cssDurationMs("0.39s", FALLBACK)).toBe(390);
  });

  it("ignores the whitespace a custom property keeps", () => {
    expect(cssDurationMs(" 390ms ", FALLBACK)).toBe(390);
  });

  it("falls back on a value it can't read", () => {
    expect(cssDurationMs("", FALLBACK)).toBe(FALLBACK);
    expect(cssDurationMs("fast", FALLBACK)).toBe(FALLBACK);
    expect(cssDurationMs(null, FALLBACK)).toBe(FALLBACK);
    // a bare number has no unit to say which it is
    expect(cssDurationMs("390", FALLBACK)).toBe(FALLBACK);
  });
});
