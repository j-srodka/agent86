# Agent86 and AI-Oriented Language — Design Spec

> This project is also known as **Agent86**.

**Status:** Draft for review  
**Date:** 2026-04-12  
**Authors:** Collaborative design (Cursor session + Claude stress-test passes)

## 1. Summary

This initiative defines a **small, portable Agent86** interchange: a versioned interchange for **what agents read, what they propose as edits, and what they get back** from tooling. The IR is the **spine**. An optional **AI-oriented surface language** (or token-efficient skin) is **out of scope for v0** except as a roadmap note; v0 optimizes **reliability, predictable context use, and validation semantics** over syntax novelty.

The problem being solved is not “parsing exists,” but **fragmented, ambiguous agent↔tool contracts**: brittle line-based edits, silent span drift, unbounded context, and prose-only failures that are hard to automate against.

## 2. Goals and non-goals

### 2.1 Goals

- **Stable addressing within a pinned workspace snapshot (Tier I)** so agents retrieve and patch **logical units**, not raw line numbers, where the spec says it is safe.
- **Machine-readable outcomes**: success, structured validation reports, and **normative rejection codes** (no silent corruption, no silent context explosion).
- **Portable interchange** so multiple agents, editors, and adapters can share one **op vocabulary** and **artifact model**.
- **Measurable harness**: baseline vs IR-backed loop on a real TypeScript monorepo with published metrics (failed patch rate, full-file reads, round trips to green tests).

### 2.2 Non-goals (v0)

- Replacing mainstream languages in production codebases.
- **Tier II identity** (durable identity across arbitrary future refactors/time without adapter cooperation and explicit events). See §4.
- Perfect CRDT-style human+agent concurrent editing for all files.
- A full new general-purpose programming language with a large standard library.

## 3. Relationship to LSP, MCP, and Tree-sitter


| Layer                     | Role relative to this IR                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **LSP**                   | Excellent for human-editor latency and IDE features; **not** a portable batch op log with content-addressed snapshots and normative agent validation reports. **Complement**, not replace. |
| **MCP**                   | Good transport and capability discovery; **not** a canonical program representation + edit calculus. **Complement**.                                                                       |
| **Tree-sitter / parsers** | Implementation detail inside **adapters**; grammar version and digest are part of snapshot integrity (§6, §9).                                                                             |


**Positioning:** the IR standardizes **agent-facing ops, snapshots, validation reports, and rejection codes**. Host ecosystems stay TS/Python/Rust/etc.; adapters bridge.

## 4. Identity model — Tier I vs Tier II

### 4.1 Tier I — Snapshot-stable identity (v0 target)

**Definition:** Identifiers are meaningful within a **WorkspaceSnapshot** that pins:

- Content-addressed file tree (or equivalent manifest),
- Parser/grammar identity and **grammar digest**,
- Adapter semver (or toolchain fingerprint),
- **Formatter / canonicalization profile** if used (§7).

**Tier I holds** only under the **named conditions and policies** in this document. Where Tier I cannot be maintained, the system **rejects** with explicit codes — it does not silently remap.

### 4.2 Tier II — Cross-time identity (explicitly out of scope for v0)

Cross-session, cross-branch, or “same behavior across arbitrary refactors” identity **without** explicit adapter events is **not promised** in v0. Roadmap items must state **which semantic invariant** would be preserved (e.g. nominal symbol vs behavioral slice).

### 4.3 Supersession and moves (Tier I events, not Tier II)

Renames/moves **within an op log** are modeled as explicit events (e.g. `move_unit` / `relocate_unit`) that **invalidate** old ids and introduce new ones. This is **not** “silent Tier II”; it is **auditable Tier I state transition**.

## 5. Core objects (conceptual)

- **WorkspaceSnapshot**: pinned tree + toolchain pins + (optional) canonicalization profile + **materialized `id_resolve` map** (§8).
- **LogicalUnit**: smallest durable patch target (e.g. function, method, module block) with **opaque id** scoped to the snapshot.
- **Span**: fine-grained range inside a unit when required.
- **Op**: small, versioned vocabulary (e.g. `replace_span`, `replace_unit`, `insert_unit`, `move_unit`, `rename_symbol` when adapter supports it).
- **ValidationReport**: structured errors/warnings, **rejection codes**, evidence fields, and **confidence** flags (e.g. reanchored vs canonical) when applicable.
- **Large artifacts**: content-addressed `sha256:` refs with **normative inline thresholds** (§10).

### 5.1 `ValidationReport` schema (normative)

The wire shape for `ValidationReport` (fields, nesting, severity enums, attachment of evidence, policy flags) belongs here. Replace the placeholder below with the full schema (e.g. JSON Schema fragment, TypeScript interface, or tables).

```typescript
/**
 * ValidationReport — normative v0 schema
 *
 * Returned on every op batch apply attempt, success or failure.
 * Agents MUST branch on `outcome` and `entries[].code`, not on message text.
 */
interface ValidationReport {
  /** Snapshot the ops were applied against. */
  snapshot_id: string;               // content-addressed hash of WorkspaceSnapshot

  /** Adapter that produced this report. */
  adapter: AdapterFingerprint;

  /** Top-level result. */
  outcome: "success" | "failure" | "partial";
  // "partial" is only valid when the batch explicitly opted in to partial apply;
  // default batch policy is atomic (success or failure, never partial).

  /** New snapshot id on success or partial success; null on failure. */
  next_snapshot_id: string | null;

  /** Updated id_resolve map entries produced by this batch: `move_unit`, `relocate_unit`, `rename_symbol`, and any other op that supersedes ids (§8). */
  id_resolve_delta: Record<string, string>;  // old_id → new_id; empty on pure reads

  /** Per-check evidence. One entry per check performed; may be empty on hard reject. */
  entries: ValidationEntry[];

  /** Blobs omitted from inline responses due to §10 threshold. Never silent. */
  omitted_due_to_size: OmittedBlob[];

  /** Toolchain fingerprint at apply time (for audit; compare to snapshot header). */
  toolchain_fingerprint_at_apply: string;
}

interface ValidationEntry {
  /** Normative code from §12.1, or a `lang.*` subcode (§12.2). Agents branch on this string. */
  code: RejectionCode | WarningCode | string; // strings starting with "lang." are adapter subcodes per §12.2

  severity: "error" | "warning" | "info";

  /** Human-readable detail. NOT for programmatic branching. */
  message: string;

  /** Which op in the batch triggered this entry, if applicable. */
  op_index: number | null;

  /** Which unit or span was the target, if applicable. */
  target_id: string | null;

  /** Scope of the check that produced this entry. Agents must not infer
   *  broader guarantees than the stated scope. */
  check_scope: CheckScope;

  /** Confidence of the id/span used in this check. */
  confidence: "canonical" | "reanchored" | "unknown";

  /** Optional structured evidence (e.g. tsc output, test result digest). */
  evidence: Record<string, unknown> | null;
}

type CheckScope =
  | "file"         // check ran on the edited file only
  | "package"      // check ran on the containing package
  | "project"      // check ran on the full project graph
  | "none";        // no check was performed (e.g. adapter does not support this check)

interface AdapterFingerprint {
  name: string;
  semver: string;
  grammar_digest: string;   // must match snapshot.grammar_digest or report grammar_mismatch
  /** Maximum ops allowed in a single apply batch for this adapter; same value MUST appear on WorkspaceSummary (§6). */
  max_batch_ops: number;
}

interface OmittedBlob {
  ref: string;    // sha256: reference
  bytes: number;  // actual size that would have been inlined
  reason: "inline_threshold" | "policy" | "unavailable";
}
```

**Normative meta-rule (§12 principle):** A `ValidationReport` MUST NOT imply broader guarantees than the adapter's actual check scope. Every `ValidationEntry` carries an explicit `check_scope`. Omissions are listed in `omitted_due_to_size`, never silenced. A missing field is never equivalent to a passing check.

**Ghost-bytes extension (pass 2, non-normative in v0):** The following optional fields on `ValidationEntry` address semantic drift that passes syntax/type checks. Implementations MAY include them; agents SHOULD consume them when present:

```typescript
interface ValidationEntry {
  // ... (fields above) ...

  /** Present when adapter can compute export surface digest (e.g. TypeScript compiler API).
   *  If the op changed the public export surface, this differs from the snapshot's digest.
   *  Unexpected change emits `surface_changed` warning. */
  export_surface_delta: "unchanged" | "changed" | "unknown";

  /** Coverage hint for the edited unit. Sourced from V8/Istanbul if available. */
  coverage_hint: {
    covered: boolean;
    coverage_source: "v8" | "istanbul" | null;
  } | null;

  /** Declaration peers not patched by this op. Emits `declaration_peer_unpatched` warning. */
  declaration_peers_unpatched: string[];  // unit_ids

  /** For rename_symbol ops: references found, rewritten, and intentionally skipped.
   *  Skipped refs are listed explicitly; absence ≠ "none found". */
  rename_surface_report: {
    found: number;
    rewritten: number;
    skipped: Array<{ unit_id: string; reason: string }>;
  } | null;
}
```

## 6. Read path

1. Agent fetches **WorkspaceSummary** (cheap): module graph digest, changed units, test map digest, **adapter capabilities** (including **`max_batch_ops`** per §5.1 `AdapterFingerprint`), and **repo policy flags** — including those required by §6.1 so the agent can branch before any write.
2. Agent retrieves **LogicalUnit** payloads **by id**, not whole files, when possible.
3. Large blobs are **by reference**; inlining obeys §10; omissions are **explicit** in the response.

**Planning-cycle coherence (normative):** All reads in a single planning cycle (**WorkspaceSummary**, **LogicalUnit** fetches, blob pulls used to build one op batch) MUST use the **same `snapshot_id`**. Agents MUST NOT mix units, policies, or capabilities from different snapshots when constructing one apply batch.

**`max_batch_ops` on summary (normative):** Every `WorkspaceSummary` MUST expose **`max_batch_ops`** (positive integer), equal to the applying adapter’s **`AdapterFingerprint.max_batch_ops`** (§5.1), so agents discover the batch limit on the read path before hitting `batch_size_exceeded` (§12.1).

### 6.1 `WorkspaceSummary` — generated-allowlist policy (normative)

The severity split for `allowlist_without_generator_awareness` (**E** for autonomous agents vs **W** for human-gated flows) depends on **repo policy that must be readable on the read path** before op construction.

**Snapshot binding:** Policy flags in a `WorkspaceSummary` are authoritative **only for the workspace snapshot they accompany** (same `snapshot_id` / content hash the agent will attach to op batches). If the snapshot is superseded (concurrent write, refresh, or `stale_snapshot` on apply — §12.1), the agent MUST re-fetch `WorkspaceSummary` for the new snapshot; it MUST NOT reuse a cached summary across snapshot changes or across sessions without verifying the snapshot id still matches.

**Requirement:** Every `WorkspaceSummary` MUST expose the effective policy for insufficient generator assertions on allowlisted generated targets. At minimum include:

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `policies.generated_allowlist_insufficient_assertions` | `"error" \| "warning"` (MAY be absent; see default below) | When `"error"`, an allowlisted op on a generated unit without `generator_will_not_run` or `generator_inputs_patched` MUST fail the batch (§11, §12.1). When `"warning"`, the adapter MUST emit `allowlist_without_generator_awareness` as **warning** and MAY allow the batch per adapter/repo rules. |

**Absent field (fail-safe):** If `policies`, `policies.generated_allowlist_insufficient_assertions`, or the whole summary predates this field (older adapter), **generic processors and adapters MUST treat the effective policy as `"error"`**. Permissive (`"warning"`) behavior MUST be explicitly declared in the summary — never inferred as default.

Adapters MUST derive this field from repo configuration when present (and MUST NOT require a separate undocumented side channel). Agents SHOULD read `WorkspaceSummary` before planning writes that touch generated units.

*(Wire shape may live in the same document or schema bundle as `ValidationReport`; a TypeScript `WorkspaceSummary` interface is left to the implementation plan.)*

## 7. Formatter drift and canonical bytes

**Problem:** Formatters (Prettier, etc.) can change bytes without semantic intent, breaking naive content-hash identity.

**v0 policy (choose one per repo; spec requires explicit declaration in snapshot):**

- **Recommended — Canonicalize before snapshot:** Adapter runs a **pinned formatter** as part of snapshot materialization. Logical ids map from **canonical bytes**. Format-only churn does not invalidate ids *within that policy*.
- **Alternative — Reject on drift:** Non-canonical bytes → `snapshot_content_mismatch` / `format_drift`; agent must refresh snapshot.

**Re-anchor via “AST equality classes”:** **Not normative in v0.** If documented later, the spec must define a **single** equality relation and conformance tests across adapters; until then, portable interchange must not depend on adapter-specific equality. Any future reanchor result must be reported as `confidence: reanchored` (not canonical), with comments explicitly classified (lossy if comments are trivia).

## 8. Id supersession chains and ghost units

**Problem:** `supersedes_id → new_id` chains cause multi-hop resolution and **ghost patches** (patching a superseded unit).

**Normative rules:**

1. **Event log** may retain the full chain for audit.
2. Every snapshot materializes a **flattened forward map** `id_resolve: old_id → current_id` that is **transitively closed** (single hop to live id).
3. **Agent-facing apply API** resolves via **id_resolve** once (or server rewrites op targets to current ids before apply); agents must not be required to traverse chains.
4. If an op targets an id that is **unknown or fully superseded without a live target**, reject with `unknown_or_superseded_id` or `ghost_unit` as appropriate.

## 9. Grammar and adapter drift

**Snapshot header** includes `adapter_semver` (or fingerprint) and **`grammar_digest`**. Snapshots **SHOULD** also pin **`adapter.name`** (and semver) as part of the same fingerprint surface as §5.1 `AdapterFingerprint`.

**Apply-time gate (normative):** Immediately before expanding ops to spans/bytes, the adapter **must** verify:

`current_adapter_grammar_digest == snapshot.grammar_digest`

Mismatch → `grammar_mismatch` (or `grammar_mismatch_on_apply` for telemetry), **even within the same agent session**.

**Grammar digest vs adapter identity (interchangeability):** **`grammar_digest` equality is the hard gate** for parser/span materialization — it is the normative **interchangeability key** between adapter builds for v0. **`adapter.name` and `adapter.semver`** (from the applying `AdapterFingerprint`) **MUST** match the snapshot’s pinned name and semver **when the snapshot records them** (recommended for all snapshots), so audits and capability negotiation stay aligned with the adapter that materialized the snapshot. **When the snapshot pins only `grammar_digest` (and semver slot) without `name`**, **`grammar_digest` match alone** authorizes apply for parser semantics; agents SHOULD still prefer snapshots that pin the full fingerprint.

**Conformance:** At least **one grammar edge-case golden** per supported language version (constructs known to stress parsers: e.g. template literals, decorators — exact set per language table).

## 10. Context and blob policy

**Problem:** Adapters disagreeing on inline vs externalized blobs causes **silent context explosion** or truncation.

**Normative default:** `inline_threshold_bytes = 8192` (UTF-8 text). Adapters **must** externalize payloads above the threshold unless the read request raises the cap.

**Responses** that omit or truncate must include `omitted_due_to_size: [{ ref, bytes }]` (or equivalent) so agents never “miss” data silently.

## 11. Generated files and provenance

**Metadata:** Files/units carry `provenance`, e.g. `{ kind: "generated", generator: "buf", inputs: [...] }` (exact schema in implementation).

**Default:** Ops targeting generated units → `illegal_target_generated`.

**Allowlist escape:** Allowed only with a **typed workflow assertion**, e.g.:

- `generator_will_not_run: true`, **or**
- `generator_inputs_patched: [unit_ids...]`

If allowlisted but neither assertion is present → `allowlist_without_generator_awareness` in `ValidationReport`. Effective severity MUST follow `WorkspaceSummary.policies.generated_allowlist_insufficient_assertions` (§6.1), including the **absent-field default** (`"error"`). **`error`** treats the condition as batch-failing; **`warning`** emits the entry but MAY allow the batch per adapter rules. Agents discover the effective policy on the **read path** before constructing ops, on the **same snapshot** as the intended op batch (§6.1 snapshot binding).

## 12. Silent corruption, ambiguity, and normative responses

This section makes Tier I falsifiable: **where bytes can change while ids might pretend stability**, the spec requires **explicit codes or confidence flags** — never silent remap.


| Risk                                  | Mitigation                                       |
| ------------------------------------- | ------------------------------------------------ |
| Formatter changes bytes               | §7 canonical profile or explicit drift rejection |
| Generated file patched then clobbered | §11 provenance + assertions + auditable warnings |
| Move creates chain / ghost unit       | §8 flattened `id_resolve` + ghost/unknown codes  |
| Grammar upgrade mid-session           | §9 apply-time digest equality                    |
| Oversized inline payloads             | §10 threshold + `omitted_due_to_size`            |
| Undefined “AST equality” portability  | §7 not normative in v0                           |
| E/W split invisible before write      | §6.1 `WorkspaceSummary` exposes generated-allowlist policy |
| Adapter-specific codes collide        | §12.2 reserved `lang.*` namespace                |


### 12.1 Rejection and warning codes (v0 draft table)

Implementations **must** use these codes where applicable; agents **should** branch on codes, not only message text.

Implementations **must** emit these codes; agents **must** branch on `code`, not `message`. Severity marked **E** = error (batch rejected or entry failed), **W** = warning (batch may proceed), **I** = info.

#### Identity and addressing

| Code | Sev | Meaning | Agent action |
|---|---|---|---|
| `unknown_or_superseded_id` | E | Op targets an id not in the current snapshot's domain and not in `id_resolve`. | Refresh snapshot; re-derive target id. |
| `ghost_unit` | E | Op targets an id present in `id_resolve` as a forward pointer, but the resolved target no longer exists as a live unit. | Treat unit as deleted; abort or re-plan. |
| `stale_snapshot` | E | Op was issued against a snapshot hash that has since been superseded by a concurrent write. | Fetch latest snapshot; replay ops if safe. |
| `id_resolve_chain_exceeded` | E | Internal: adapter detected a non-flattened chain (implementation bug). | Report to adapter maintainer; refresh snapshot. |

#### Formatter and canonical bytes (§7)

| Code | Sev | Meaning | Agent action |
|---|---|---|---|
| `snapshot_content_mismatch` | E | File bytes do not match the canonicalization profile declared in the snapshot header. | Re-canonicalize and re-snapshot before applying ops. |
| `format_drift` | E | Formatter-only byte change detected between snapshot and apply time (policy: reject-on-drift). | Refresh snapshot under canonical-bytes policy. |
| `reanchored_span` | W | Span was re-anchored via AST proximity (non-normative path). Result has `confidence: reanchored`. | Human review recommended before commit. |

#### Grammar and adapter integrity (§9)

| Code | Sev | Meaning | Agent action |
|---|---|---|---|
| `grammar_mismatch` | E | Snapshot grammar digest does not match adapter grammar digest at apply time. | Upgrade or pin adapter to match snapshot; re-snapshot. |
| `grammar_mismatch_on_apply` | E | As above but detected mid-session after a previously matching snapshot (finer telemetry subcode). | Same as `grammar_mismatch`; flag session toolchain instability. |
| `adapter_version_unsupported` | E | Adapter semver is below the minimum required by the snapshot format version. | Upgrade adapter. |
| `parse_error` | E | Op expansion produced a syntactically invalid result per the pinned grammar. | Agent must not commit; inspect op and target unit. |

#### Generated files and provenance (§11)

| Code | Sev | Meaning | Agent action |
|---|---|---|---|
| `illegal_target_generated` | E | Op targets a unit with `provenance.kind = "generated"` and no allowlist assertion is present. | Do not patch generated file directly; patch generator inputs instead. |
| `allowlist_without_generator_awareness` | E/W | Op targets a generated unit with allowlist, but neither `generator_will_not_run` nor `generator_inputs_patched` is asserted. Effective **E** vs **W** MUST match `WorkspaceSummary.policies.generated_allowlist_insufficient_assertions` (§6.1), including default **`error`** when the field is absent. | Read §6.1 before write; add typed workflow assertion or remove allowlist. |

#### Context and blob policy (§10)

| Code | Sev | Meaning | Agent action |
|---|---|---|---|
| `inline_threshold_exceeded` | W | One or more payloads were externalized; see `omitted_due_to_size`. | Fetch refs explicitly if content is needed. |
| `blob_unavailable` | W | A `sha256:` ref exists in the snapshot but the blob is not retrievable. | Proceed without the blob or abort depending on op dependency. |

#### Validation scope (§5.1)

| Code | Sev | Meaning | Agent action |
|---|---|---|---|
| `typecheck_scope_file` | I | Type check ran on edited file only; project-level guarantees not provided. | Autonomous agents requiring full soundness must run project-scope check before commit. |
| `typecheck_scope_none` | I | No type check was performed (adapter does not support it or it was skipped). | Do not assume type safety. |
| `parse_scope_file` | I | Parse check ran on edited file only. | Cross-file ref validity not verified. |

#### Semantic surface warnings (pass 2 — non-normative in v0; MAY be emitted)

| Code | Sev | Meaning | Agent action |
|---|---|---|---|
| `surface_changed` | W | Op changed the package's computed export surface digest. May be intentional. | Review exported API diff before merging. |
| `declaration_peer_unpatched` | W | Unit has `.d.ts` or other declaration peers that were not included in this op batch. | Patch peers or assert they are auto-generated. |
| `rename_surface_skipped_refs` | W | `rename_symbol` op found references it intentionally did not rewrite (e.g. legacy-compat re-exports). See `rename_surface_report`. | Review skipped ref list; patch or assert intentional. |
| `coverage_unknown` | I | No coverage data available for the edited unit; test coverage cannot be confirmed. | Run coverage instrumentation before asserting test safety. |
| `coverage_miss` | W | Edited unit has zero test coverage per available coverage data. | Add tests or acknowledge untested patch explicitly. |

#### Op batch policy

| Code | Sev | Meaning | Agent action |
|---|---|---|---|
| `partial_apply_not_permitted` | E | Batch requested partial apply but repo policy requires atomicity. | Resubmit as atomic batch or split ops logically. |
| `op_vocabulary_unsupported` | E | Op type is not supported by this adapter version. | Check adapter capabilities; use a supported op or upgrade adapter. |
| `batch_size_exceeded` | E | Op batch exceeds adapter-declared max batch size. | Split into smaller batches. |

### 12.2 `lang.*` namespace — language-specific subcodes (normative)

The core codes in §12.1 stay **stable and portable**. Adapters MUST NOT mint new **top-level** codes for language- or grammar-specific conditions (that would fork the portable table and cause collisions).

**Reserved prefix:** `lang.` — all codes whose first dot-separated segment is exactly `lang` are **language-specific subcodes**.

- **Pattern:** `lang.<lang_id>.<slug>` (examples: `lang.ts.decorator_edge_case`, `lang.py.soft_keyword_ambiguity`). Use a short stable `lang_id` (`ts`, `py`, `rs`, …); slugs are adapter-defined but SHOULD be stable across adapter versions when the condition is the same.
- **Core processors** (linters, aggregators, generic agents) MUST treat unknown `lang.*` codes as **opaque**: forward-compatible, loggable, displayable — never mistaken for a core code.
- **Unknown `lang.*` + severity (normative):** If the processor does not understand a `lang.*` `code`, it MUST honor the entry’s declared **severity** without downgrading: an unknown `lang.*` with **`severity: error`** MUST be treated as a **hard reject** (same as a core error — batch or step fails). An unknown `lang.*` with **`severity: warning`** or **`severity: info`** MUST be **passed through** unchanged (no downgrade to info, no upgrade to error). That preserves forward compatibility without suppressing blocking adapter signals.
- **Adapters** MUST document each emitted `lang.*` code in the adapter capability manifest for that snapshot (or equivalent machine-readable surface). **Discovery** for that manifest is an open item (§16).

Optional `lang.*` entries still use `ValidationEntry` in §5.1; the `code` field carries those strings in addition to core union members (see interface above).

## 13. Write path

1. Agent emits **batch of `Op`s** against a known `WorkspaceSnapshot` id/hash.
2. Adapter runs **§9 apply-time gate**, resolves ids via **§8**, expands ops, validates (parse; type if available).
3. On failure: return **ValidationReport** with codes; **no partial silent apply** unless explicitly specified and safe (default: atomic batch).
4. On success: return new snapshot hash, updated **id_resolve**, and optional proof fields (tests run, etc.).

## 14. Harness and adoption (v0)

**Primary harness language:** **TypeScript** (Tree-sitter maturity, LSP ubiquity, Cursor/VS Code ecosystem, shortest path for skeptical “tool Y” proofs).

**Archetype:** Mid-sized **open-source TypeScript monorepo** with real CI; exact repo TBD after license/CI feasibility check.

**A/B measurement:**

- **Baseline:** agent loop with naive string/file edits.
- **Treatment:** same loop with **ops → adapter → validate-before-write**.

**Metrics:** failed patch rate, count of full-file reads, round trips until green test run (plus token read volume where instrumented).

**Adoption reality:** Spec value scales with **multiple consumers**. v0 ships a **reference implementation** + **conformance tests** + **publishable harness numbers**.

## 15. Roadmap notes (non-normative)

- **Bilingual projection:** canonical IR serialization + deterministic human-facing render for review; full lossless round-trip merge semantics **later**.
- **AI-oriented surface language / token skin:** maps to same ops; separate track after IR proves value.

## 16. Open items for next review pass

- **Ghost semantics audit (semantics vs syntax):** addressed in §5.1 optional extension fields (`export_surface_delta`, `coverage_hint`, `declaration_peers_unpatched`, `rename_surface_report`) and §12.1 pass-2 warning codes. Non-normative in v0 but schema-compatible; harness should instrument and report them.
- **`lang.*` manifest discovery (§12.2):** specify how an agent obtains the machine-readable manifest (well-known URL, field on `AdapterFingerprint` / `WorkspaceSummary`, repo-relative file, MCP resource URI, etc.). Without this, each adapter will invent its own discovery path.
- Exact **Op** vocabulary and JSON/CBOR schema versioning.
- Per-language **golden edge-case** list.
- Repo selection for harness and CI budget.

---

## Spec self-review (inline)

- `ValidationReport` schema (§5.1) includes `id_resolve_delta` (moves, **`relocate_unit`**, renames), `AdapterFingerprint.max_batch_ops`, and rejection-code table (§12.1); §6 planning-cycle `snapshot_id` + `max_batch_ops` on summary; §6.1 policy snapshot binding + fail-safe default; §9 grammar-digest gate vs adapter identity; §12.2 `lang.*` unknown-severity rules; §16 manifest discovery and other items scoped as implementation-time.
- Tier I vs Tier II boundary explicit; moves are Tier I events with flattened map.
- Formatter, generated, grammar-at-apply, and blob policies address silent corruption audit pass 1.
- Scope fits one implementation plan for reference adapter + harness.

**Next step after your review:** implementation planning (separate `writing-plans` phase) for reference adapter, snapshot materialization, and TS monorepo harness.