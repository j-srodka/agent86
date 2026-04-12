# agent86

**agent86** is a portable, versioned interchange for agent-to-tool and agent-to-agent code editing: **ops**, **snapshots**, **validation reports**, and **rejection codes** agents can branch on deterministically—instead of prose errors they have to parse.

**Status:** v0 prototype — spec locked, reference implementation in progress.

## The problem

Agents editing code today still lean on brittle **line-number** references, get **prose-only** failures from tools, and often **read whole files** when they only need one function. There is **no portable** way to say “apply this validated edit” or “reject with a machine-readable reason” that works the same across editors, CLIs, and custom glue. Every agent–tool pair ends up inventing another **incompatible JSON dialect** for the same handful of operations. That is not a programming-language syntax problem—it is a **missing contract layer** between agents and the software that actually touches the tree.

## What this is

A small **Agent IR** (intermediate representation): a **locked spec** plus a **reference implementation** defining `WorkspaceSnapshot` (content-addressed, grammar-pinned), `LogicalUnit` (the smallest stable patch target), a minimal **Op** vocabulary for v0 (`replace_unit`, `rename_symbol`), and `ValidationReport` with **normative rejection codes** agents can branch on deterministically (see spec §12.1). The IR sits **above** host machinery (LSP, Tree-sitter, `tsc`, formatters) and **below** agent reasoning—it is the **contract**, not a replacement for either layer.

**What it is not:**

- **Not** a new general-purpose programming language (optional later surface / skin is out of scope for v0).
- **Not** a replacement for **LSP** or **MCP**—it **complements** them (see below).
- **Not** production-ready: this is a **v0 prototype**; APIs and repo layout will move until the reference adapter and harness prove out.

## Key design properties (v0)

- **Tier I snapshot-stable identity:** logical units addressed by **opaque ids** within a pinned snapshot—not line numbers as the source of truth.
- **Normative rejection codes:** agents branch on `code`, not freeform `message` text.
- **Explicit scope** on validation entries: no implied guarantees beyond what the adapter actually checked (see spec §5.1).
- **Normative inline threshold** for large payloads: avoid **silent context explosion**; omissions are reported explicitly.
- **Formatter and grammar drift** are handled with explicit policies and failures—**no silent remap** of ids or spans.
- **Measurable by design:** v0 ships an A/B harness measuring failed patch rate, full-file reads, and round trips to green tests against a real TypeScript monorepo — so the IR either demonstrates value or tells you why it doesn't.

## Repo structure


| Path                      | Purpose                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `docs/superpowers/specs/` | Locked design spec                                                                         |
| `docs/superpowers/plans/` | Implementation plan (task order, gates, amendments)                                        |
| `docs/impl/`              | v0 implementation decisions (`v0-decisions.md`), proposed spec edits (`spec-proposals.md`) |
| `packages/ts-adapter/`    | Reference **TypeScript** adapter (Tree-sitter) — scaffolded per plan                       |
| `packages/conformance/`   | Golden fixtures + conformance test runner                                                  |
| `packages/ab-harness/`    | A/B harness: baseline vs IR-backed loop, metrics                                           |


Collaboration and agent rules: `AGENTS.md`. Cursor-specific constraints: `.cursor/rules/agent86.mdc`. Read the spec before the code: `docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md`.

## Getting started

**Prerequisites:** Node 22+, **pnpm**

```bash
pnpm install
pnpm -r build
pnpm --filter conformance test
pnpm --filter ab-harness start   # requires TARGET_REPO_URL and TARGET_REPO_REV

```

These commands assume the **pnpm workspace and packages** exist as described in the implementation plan. **They will not succeed until the reference implementation is further along.** If you clone now, treat the repo as **spec + plan + collaboration docs** — the working adapter and harness are in progress.

## Contributing and collaboration

Work here uses a **human-in-the-loop multi-agent** setup: **Cursor** as the primary implementer, **Claude (claude.ai)** as an external stress-tester and reviewer (no direct repo access—relay via the human). Read `AGENTS.md` for autonomy policy, spec lock rules, and commit conventions. **Spec amendments** are proposed in `docs/impl/spec-proposals.md` and applied to the locked spec **only by a human**. If you want to collaborate, build another language adapter, or integrate a tool, **open an issue or reach out**; the IR is intentionally **portable and adapter-agnostic**.

## Relationship to LSP and MCP

**LSP** is optimized for human-editor latency and rich IDE features; **MCP** provides transport and capability discovery. This project adds a layer those were not designed to own: a **normative op vocabulary**, **content-addressed snapshots**, and **structured validation reports** aimed at **autonomous agent** edit loops—not at replacing your language server or MCP server.

## License

License: **TBD**