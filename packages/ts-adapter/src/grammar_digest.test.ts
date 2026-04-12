import { describe, expect, it } from "vitest";
import { createTypeScriptParser, parseTypeScriptSource } from "./parser.js";
import {
  GRAMMAR_DIGEST_V0,
  computeGrammarDigestFromArtifact,
  grammarArtifactPath,
} from "./grammar_meta.js";

describe("grammar digest (Task 2)", () => {
  it("computes SHA-256 of parser.c and matches checked-in GRAMMAR_DIGEST_V0", () => {
    expect(computeGrammarDigestFromArtifact()).toBe(GRAMMAR_DIGEST_V0);
  });

  it("fails a naive wrong digest (guards accidental constant edits)", () => {
    const wrong = "0".repeat(64);
    expect(wrong).not.toBe(computeGrammarDigestFromArtifact());
    expect(wrong).not.toBe(GRAMMAR_DIGEST_V0);
  });

  it("returns the same digest on repeated reads in one process", () => {
    const a = computeGrammarDigestFromArtifact();
    const b = computeGrammarDigestFromArtifact();
    expect(a).toBe(b);
    expect(a).toBe(GRAMMAR_DIGEST_V0);
  });

  it("exposes a stable artifact path ending in typescript/src/parser.c", () => {
    expect(grammarArtifactPath().replaceAll("\\", "/").endsWith("typescript/src/parser.c")).toBe(
      true,
    );
  });

  it("loads two parsers and parses trivial TypeScript", () => {
    const p1 = createTypeScriptParser();
    const p2 = createTypeScriptParser();
    const t1 = p1.parse("export const n = 1;\n");
    const t2 = p2.parse("export const n = 1;\n");
    expect(t1.rootNode.type).toBe("program");
    expect(t2.rootNode.type).toBe("program");
  });

  it("parses via parseTypeScriptSource helper", () => {
    const tree = parseTypeScriptSource("let x: number;");
    expect(tree.rootNode.hasError).toBe(false);
  });
});
