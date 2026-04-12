import { describe, expect, it } from "vitest";
import { detectProvenance, fileMatchesGeneratedEditAllowlist, firstNLines } from "./provenance.js";

describe("detectProvenance", () => {
  it("classifies header @generated", () => {
    const lines = firstNLines(`// @generated\nexport function f(): void {}\n`, 5);
    expect(detectProvenance("src/a.ts", lines)).toEqual({
      kind: "generated",
      detected_by: "header:@generated",
    });
  });

  it("classifies DO NOT EDIT in first five lines", () => {
    const lines = firstNLines(`/*\n * DO NOT EDIT\n */\nexport function f(): void {}\n`, 5);
    expect(detectProvenance("src/a.ts", lines)).toEqual({
      kind: "generated",
      detected_by: "header:do-not-edit",
    });
  });

  it("matches __generated__ path segment before authored fallback", () => {
    expect(detectProvenance("app/__generated__/x.ts", [])).toEqual({
      kind: "generated",
      detected_by: "path:segment:__generated__",
    });
  });

  it("matches generated path segment", () => {
    expect(detectProvenance("src/generated/models.ts", [])).toEqual({
      kind: "generated",
      detected_by: "path:segment:generated",
    });
  });

  it("matches .generated.ts suffix", () => {
    expect(detectProvenance("foo/types.generated.ts", [])).toEqual({
      kind: "generated",
      detected_by: "ext:.generated.ts",
    });
  });

  it("matches .pb.ts suffix", () => {
    expect(detectProvenance("proto/foo.pb.ts", [])).toEqual({
      kind: "generated",
      detected_by: "path:*.pb.ts",
    });
  });

  it("returns authored when no rule matches", () => {
    expect(detectProvenance("src/handwritten.ts", ["// safe"])).toEqual({ kind: "authored" });
  });
});

describe("fileMatchesGeneratedEditAllowlist", () => {
  it("matches exact path", () => {
    expect(
      fileMatchesGeneratedEditAllowlist("gen/out.ts", {
        generated_edit_allowlist: ["gen/out.ts"],
      }),
    ).toBe(true);
  });

  it("matches directory prefix ending with /**", () => {
    expect(
      fileMatchesGeneratedEditAllowlist("gen/sub/x.ts", {
        generated_edit_allowlist: ["gen/**"],
      }),
    ).toBe(true);
  });

  it("rejects when not listed", () => {
    expect(fileMatchesGeneratedEditAllowlist("other.ts", { generated_edit_allowlist: ["a.ts"] })).toBe(
      false,
    );
  });
});
