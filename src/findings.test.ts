import { describe, expect, it } from "vitest";
import { mergeFindings } from "./findings.js";

describe("mergeFindings", () => {
  it("prefers env over betterleaks and builtin for the same value", () => {
    const merged = mergeFindings([
      { category: "builtin", value: "same-secret", source: "builtin" },
      { category: "github-pat", value: "same-secret", source: "betterleaks" },
      { category: "api_token", value: "same-secret", source: "env" },
    ]);
    expect(merged).toEqual([{ category: "api_token", value: "same-secret", source: "env" }]);
  });

  it("orders longer values first", () => {
    const merged = mergeFindings([
      { category: "short", value: "abcdefghi", source: "builtin" },
      { category: "long", value: "abcdefghijklmnop", source: "builtin" },
    ]);
    expect(merged.map((item) => item.category)).toEqual(["long", "short"]);
  });
});
