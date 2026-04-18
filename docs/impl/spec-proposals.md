# Spec proposals

Proposed amendments to the locked spec. Each entry must include: date, proposing agent, the proposed change as a diff or clearly marked block, and rationale. A human must approve and apply any proposal to the spec file.

---

## 2026-04-12 — `id_superseded` warning code (Cursor)

**Rationale:** v1 `move_unit` + section 8 auto-resolve emits an explicit `**id_superseded`** warning when an op `target_id` is resolved via `id_resolve` so resolution is never silent. The locked spec section 12.1 table does not yet list this code.

**Placement:** Add the row to the **Identity and addressing** group of section 12.1 (same subsection as `unknown_or_superseded_id`, `ghost_unit`, etc.).

**Normative details:**

- **Severity:** Always `**warning`**. Not policy-configurable (unlike e.g. generated-allowlist policy on the read path).
- **Evidence:** `evidence` **must** include `**{ resolved_to: string }`** (the live unit id after `id_resolve`).

**PROPOSED — add to section 12.1, Identity and addressing table, new row:**

| `id_superseded` | W | Op `target_id` was a superseded id; the adapter resolved it via `id_resolve` to a live unit. | Confirm the op was intended for the resolved location; branch on `code` and `evidence.resolved_to` (string). |

---

## 2026-04-18 — `lang.agent86.snapshot_id_mismatch` (Cursor)

**Rationale:** `@agent86/sdk` can reject an op batch **before** MCP when **`source_snapshot_id`** lines on queued ops disagree with **`.apply({ snapshot_id })`** (compose-time bug). This is not **`stale_snapshot`** (workspace moved on) nor **`unknown_or_superseded_id`** (id not in domain) — it needs a distinct **`lang.agent86.*`** code for diagnostic precision.

**Placement:** Add a normative row (or footnote under §12.2) cross-referencing **SDK contract** — or, if human editors prefer core-table purity, keep it **`lang.*`-only** under §12.2 with the same **Identity and addressing** theme as Tier I provenance.

**PROPOSED — normative summary:**

| Code | Sev | Meaning | Agent action |
|------|-----|---------|----------------|
| `lang.agent86.snapshot_id_mismatch` | E | SDK queued ops whose `source_snapshot_id` provenance disagrees with `apply_batch.snapshot_id`, or mixes multiple source snapshots in one batch. | Align `apply.snapshot_id` with `UnitRef.snapshot_id` (or pass a consistent `source_snapshot_id` on every op). |

**Evidence (normative for SDK):** `{ apply_snapshot_id: string; builder_snapshot_ids: string[]; reason: "apply_mismatch" \| "builder_multi_snapshot" \| "incomplete_source_snapshot_ids" }`.

---

## 2026-04-13 — `format_drift` severity reclassification (Cursor)

**Rationale:** Section 12.1 lists `format_drift` as **E** (error) with the agent action “refresh snapshot under canonical-bytes policy.” The reference adapter (v1) may emit **`format_drift` as a warning** when formatter integration is partial (e.g. LF-only checks without a pinned Prettier round-trip), so the batch can succeed while still surfacing drift for audit. That intentionally diverges from the portable table’s **E** for this repo until the spec explicitly allows **E** vs **W** per repo policy or adapter capability.

**Placement:** Section 12.1 — **Formatter and canonical bytes** table, `format_drift` row.

**PROPOSED — replace the `format_drift` row (or add normative text immediately below the table):**

| Code | Sev | Meaning | Agent action |
|------|-----|---------|----------------|
| `format_drift` | **E or W (policy)** | Formatter-only or canonicalization byte drift detected between snapshot materialization expectations and post-edit content. **Severity** is determined by **repo / adapter policy** (e.g. reject-on-drift **E** when a pinned formatter round-trip is enforced; **W** when the adapter reports drift for audit but allows the batch to succeed under partial formatter integration). | If **E**: refresh snapshot under canonical-bytes policy. If **W**: review bytes; refresh snapshot if identity guarantees require it. |

**Alternative (minimal):** Keep **E** in the portable table but add a normative sentence: *Implementations MAY downgrade `format_drift` to **warning** when documented in adapter capability metadata and repo policy; agents MUST honor the entry’s declared `severity`.*

**Status:** **Approved (2026-04-13).** Applied to the locked spec `format_drift` row: *Severity MAY be downgraded to W by adapters operating under partial formatter integration; the downgrade must be documented in the adapter's decisions log.*

---