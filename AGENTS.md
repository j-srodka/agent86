# AGENTS.md — agent86 multi-agent collaboration

## Purpose

This repository prototypes **portable Agent86** (interchange representation) for **agent-to-tool** and **agent-to-agent** editing workflows: snapshots, stable addressing within a snapshot, validated ops, and structured **`ValidationReport`** outcomes aligned with the locked v0 spec.

Agents working here implement the **reference TypeScript adapter** (Tree-sitter), **conformance goldens**, and an **A/B measurement harness** per the active implementation plan.

## Agent roster

| Agent | Role | Access |
| ----- | ---- | ------ |
| **Cursor** | Primary coder; runs autonomously during the prototyping phase (see below). | Full repo (clone, edit, test, commit). |
| **Claude (claude.ai)** | External stress-tester and reviewer; no direct git access. | Via human relay only. |
| **Claude Code** (optional, future) | If used: secondary coding agent; same repo rules as Cursor unless policy is updated in this file. | Full repo when enabled. |

## Autonomy policy (prototyping phase)

During prototyping, **Cursor may scaffold, edit, commit, and make implementation decisions freely** within the boundaries of the **current task** in the implementation plan. **Human approval is not required** for routine code changes.

This policy **may tighten** after a successful prototype; always treat **AGENTS.md** as the source of truth for the current phase.

## Spec lock rule

- **Locked spec (do not edit in-repo via agents):**  
  `docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md`
- **Status:** LOCKED for v0. **Cursor and Claude must not apply direct edits** to this file.
- **Amendments:** **Proposals only** — clearly marked suggestions in chat, or entries in **`docs/impl/spec-proposals.md`** (timestamp, proposing agent, diff or marked block, rationale). A **human** approves and applies changes to the spec file.

## Implementation decisions

All **implementation-phase** decisions (grammar pin strategy bump notes, chosen OSS repo SHA, manifest discovery choice, op JSON shape, etc.) belong in:

**`docs/impl/v0-decisions.md`**

**Suggested entry format:**

- **Date** (ISO)
- **Decision** (one line)
- **Rationale**
- **Alternatives considered** (short)

Do not use the locked spec or scattered inline comments as the substitute for this log.

## Key file map

| Path | Role |
| ---- | ---- |
| `docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md` | Locked v0 spec |
| `docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md` | Active implementation plan (task order, gates, amendments) |
| `docs/impl/v0-decisions.md` | Implementation decisions log (create/update per plan) |
| `docs/impl/spec-proposals.md` | Proposed spec amendments only (human applies to spec) |
| `packages/ts-adapter/` | Reference adapter (when scaffolded) |
| `packages/conformance/` | Golden / conformance tests (when scaffolded) |
| `packages/ab-harness/` | A/B harness (when scaffolded) |

## Commit conventions

Use **Conventional Commits**: `feat:`, `fix:`, `chore:`, `test:`, `docs:`, etc.

When a change maps to the implementation plan, **reference the task** in the subject when helpful, e.g.:

- `chore(task-0): scaffold pnpm workspace`
- `feat(task-3): snapshot materialization`

**Commit after each completed task**, not after every micro-step (see `.cursor/rules`).

## Hand off to Claude (claude.ai) for review

1. Human copies **relevant output** from Cursor (diff summary, failing tests, `ValidationReport` samples, or a PR link) into **claude.ai**.
2. Claude returns a **stress-test or review pass** (gaps, silent-failure risks, spec alignment).
3. Human pastes Claude’s reply **back into the Cursor chat** so the coding agent can act on it.

Flag in your Cursor task summary when output is **intended for Claude review** so the human knows to relay it.
