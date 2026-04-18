export type {
  SearchCriteria,
  SearchUnitKind,
  UnitRef,
  RejectionCode,
  AdapterFingerprint,
  ValidationReport,
  ValidationEntry,
  ValidationEntryCode,
  ValidationOutcome,
  CheckScope,
  EntryConfidence,
  EntrySeverity,
  LangSubcode,
  OmittedBlob,
  RenameSurfaceReport,
  SpecNormativeCode,
} from "./types.js";

export { REJECTION_CODES, phraseForNormativeCode, type RejectionPhraseCategory } from "./rejection-codes.js";

export {
  Agent86JsonRpcTransport,
  Agent86ToolError,
  Agent86TransportError,
  type Agent86Transport,
  type Agent86TransportOptions,
  type CallToolResultWire,
} from "./transport.js";

export { search, mergeSearchCriteria, normalizeUnitRef, type SearchOptions, type SearchWarning } from "./search.js";

export {
  builder,
  OpBatchBuilder,
  type ApplyBatchInput,
  type MoveUnitInput,
  type RenameSymbolInput,
  type ReplaceUnitInput,
} from "./builder.js";

export { Agent86Sdk, type Agent86SdkOptions } from "./agent86-sdk.js";
