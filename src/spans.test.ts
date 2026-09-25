import { describe, expect, it } from "vitest";
import { maskOccupied, type Span } from "./spans.js";

function span(start: number, end: number): Span {
  return { start, end, value: "", label: "", stage: "blacklist" };
}

describe("maskOccupied", () => {
  it("keeps utf-16 offsets for non-bmp text", () => {
    const text = "a😀b";
    const masked = maskOccupied(text, [span(1, 3)]);
    expect(masked).toBe("a  b");
    expect(masked.length).toBe(text.length);
    expect(masked.codePointAt(1)).toBe(32);
  });

  it("merges adjacent, overlapping, duplicate, and unsorted spans", () => {
    const text = "abcdefghij";
    const masked = maskOccupied(text, [span(6, 8), span(1, 3), span(2, 4), span(4, 4), span(1, 3)]);
    expect(masked).toBe("a   ef  ij");
    expect(masked.length).toBe(text.length);
  });

  it("ignores empty and out-of-range spans", () => {
    const text = "abcd";
    expect(maskOccupied(text, [span(4, 8), span(-2, 0), span(2, 2)])).toBe(text);
    expect(maskOccupied("", [span(0, 1)])).toBe("");
  });
});
