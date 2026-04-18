export type {
  AdapterFingerprint,
  CheckScope,
  EntryConfidence,
  EntrySeverity,
  LangSubcode,
  OmittedBlob,
  RenameSurfaceReport,
  SpecNormativeCode,
  ValidationEntry,
  ValidationEntryCode,
  ValidationOutcome,
  ValidationReport,
} from "ts-adapter";

export type SearchUnitKind = "function" | "method" | "class" | "reference" | "import";

/**
 * Normative search filter shape (Agent86 SDK v3); passed to the `search_units` tool.
 */
export interface SearchCriteria {
  kind: SearchUnitKind;
  name?: string;
  enclosing_class?: string;
  path_prefix?: string;
  imported_from?: string;
  tags?: string[];
}

/**
 * Portable unit handle returned by search; aligned with `search_units` / snapshot units.
 */
export interface UnitRef {
  id: string;
  file_path: string;
  kind: SearchUnitKind;
  name?: string;
  enclosing_class?: string;
  imported_from?: string;
  tags?: string[];
}

/** Normative §12.1 table codes for programmatic branching (language-specific uses `lang.*`). */
export type RejectionCode = import("ts-adapter").SpecNormativeCode;
