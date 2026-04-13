# CLAUDE.md — agent86 (Claude Code / Claude sessions)

## What this repo is

A **prototype** of **portable Agent86** for agent-to-tool and agent-to-agent editing: snapshots, Tier I addressing, validated ops, structured **`ValidationReport`**, TypeScript reference adapter (Tree-sitter), conformance goldens, and an A/B harness.

## Read first

1. **`AGENTS.md`** (repo root) — roster, autonomy, spec lock, file map, commit rules, Claude handoff.
2. **`docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md`** — **current task state** and execution gates.

## Spec is locked

- **Do not edit:** `docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md`
- **Proposals only:** `docs/impl/spec-proposals.md` — timestamp, proposing agent, PROPOSED change, rationale. A **human** applies approved edits to the spec.

## Implementation vs spec

Decisions during build go to **`docs/impl/v0-decisions.md`**, not the spec.

## Autonomy

**Prototyping phase:** coding agents (Cursor; Claude Code if used) may work **autonomously within task boundaries** per **AGENTS.md**. That policy **may change** — re-read **AGENTS.md** when starting a session.

## Claude roles

- **claude.ai (primary):** External reviewer / stress-tester; **no repo access**; human relays copy-paste.
- **Claude Code (secondary, optional):** Same repo rules as Cursor when used for implementation.

## Technical reminders

- **`grammar_digest`:** Plan Task 2 — artifact hash constant, **not** npm version string alone.
- **Deterministic snapshots;** atomic batches by default; **normative codes** in reports (spec §12.1).
