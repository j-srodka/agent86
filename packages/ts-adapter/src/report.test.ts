import { describe, expect, it } from "vitest";
import {
  buildFailureReport,
  buildSuccessReport,
  stubAllowlistWithoutGeneratorAwarenessEntry,
} from "./report.js";
import type { AdapterFingerprint, ValidationEntry, ValidationReport } from "./types.js";

const fingerprint = (): AdapterFingerprint => ({
  name: "ts-adapter",
  semver: "0.0.0",
  grammar_digest: "deadbeef",
  max_batch_ops: 50,
});

const toolchain = "toolchain:test";

describe("ValidationReport JSON round-trip", () => {
  it("round-trips a synthetic success report", () => {
    const report: ValidationReport = buildSuccessReport({
      snapshot_id: "snap:before",
      next_snapshot_id: "snap:after",
      adapter: fingerprint(),
      toolchain_fingerprint_at_apply: toolchain,
      entries: [
        {
          code: "parse_scope_file",
          severity: "info",
          message: "Parse check ran on edited file only.",
          op_index: null,
          target_id: null,
          check_scope: "file",
          confidence: "canonical",
          evidence: null,
        },
      ],
    });
    const revived = JSON.parse(JSON.stringify(report)) as ValidationReport;
    expect(revived).toEqual(report);
    expect(revived.outcome).toBe("success");
    expect(revived.toolchain_fingerprint_at_apply).toBe(toolchain);
    expect(revived.id_resolve_delta).toEqual({});
    expect(revived.omitted_due_to_size).toEqual([]);
    expect(revived.entries[0]?.code).toBe("parse_scope_file");
  });

  it("round-trips failure entries using section 12.1 subset codes", () => {
    const entries: ValidationEntry[] = [
      {
        code: "parse_error",
        severity: "error",
        message: "Unexpected token",
        op_index: 0,
        target_id: "unit:1",
        check_scope: "file",
        confidence: "canonical",
        evidence: { line: 2, column: 4 },
      },
      {
        code: "grammar_mismatch",
        severity: "error",
        message: "Digest mismatch",
        op_index: null,
        target_id: null,
        check_scope: "none",
        confidence: "canonical",
        evidence: null,
      },
      {
        code: "batch_size_exceeded",
        severity: "error",
        message: "Too many ops",
        op_index: null,
        target_id: null,
        check_scope: "none",
        confidence: "canonical",
        evidence: { attempted: 99, max_batch_ops: 50 },
      },
      {
        code: "illegal_target_generated",
        severity: "error",
        message: "Target is generated without allowlist path",
        op_index: 1,
        target_id: "unit:gen",
        check_scope: "file",
        confidence: "canonical",
        evidence: null,
      },
      stubAllowlistWithoutGeneratorAwarenessEntry({
        op_index: 2,
        target_id: "unit:gen2",
        severity: "error",
      }),
      {
        code: "lang.ts.example_edge",
        severity: "warning",
        message: "Adapter-defined lang subcode",
        op_index: null,
        target_id: null,
        check_scope: "file",
        confidence: "unknown",
        evidence: null,
      },
    ];
    const report = buildFailureReport({
      snapshot_id: "snap:x",
      adapter: fingerprint(),
      toolchain_fingerprint_at_apply: toolchain,
      entries,
    });
    const revived = JSON.parse(JSON.stringify(report)) as ValidationReport;
    expect(revived).toEqual(report);
    expect(revived.outcome).toBe("failure");
    expect(revived.toolchain_fingerprint_at_apply).toBe(toolchain);
    expect(revived.id_resolve_delta).toEqual({});
    expect(revived.omitted_due_to_size).toEqual([]);
    expect(revived.next_snapshot_id).toBeNull();
  });
});
