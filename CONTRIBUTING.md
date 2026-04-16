# Contributing to Agent86

Thank you for your interest in contributing. This document covers
how to get started, propose changes, and submit pull requests.

## Getting started

```bash
git clone https://github.com/j-srodka/agent86.git
cd agent86
pnpm install
pnpm -r build
pnpm test
```

Node 22+ and pnpm are required (see root `package.json` for the
pinned `packageManager` version).

## What you can contribute

- **Bug reports** — open an issue using the Bug Report template
- **New language adapters** — open a Discussion first to align on
  the adapter interface before writing code
- **MCP server improvements** — open an issue describing the change
- **Documentation fixes** — PRs welcome without prior discussion
- **Spec proposals** — see "Proposing spec changes" below

## Proposing spec changes

The v0 spec at
`docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md`
is **locked**. Agents and contributors must not edit it directly.

To propose a change:
1. Add a dated `PROPOSED` block to `docs/impl/spec-proposals.md`
   with your proposed diff, rationale, and your GitHub handle
2. Open an issue linking to the proposal
3. A maintainer will review and apply approved changes to the spec

## Implementation decisions

All repo-specific implementation choices (grammar pin strategy,
adapter fingerprint decisions, op JSON shape, etc.) belong in
`docs/impl/v0-decisions.md`. If your PR introduces a new choice,
add an entry to that file.

## Running tests

```bash
# All packages
pnpm test

# Specific adapter
pnpm --filter ts-adapter test
pnpm --filter @agent86/py-adapter test
pnpm --filter @agent86/js-adapter test

# MCP server smoke tests
pnpm --filter @agent86/mcp-server test

# Conformance goldens
pnpm --filter conformance test
```

Always run `pnpm -r build` before running conformance tests when
adapter source has changed.

## Pull request conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `chore:`, `docs:`, `test:`
- One logical change per PR
- All existing tests must pass
- Add tests for new behavior
- Update `docs/impl/v0-decisions.md` if your PR introduces a new
  implementation-time choice

## Adding a new language adapter

New adapters must:
1. Live in `packages/<lang>-adapter/`
2. Export the same public surface as `ts-adapter` and
   `@agent86/py-adapter` (materializeSnapshot, applyBatch,
   buildWorkspaceSummary)
3. Pin a grammar digest constant using the same SHA-256 strategy
   documented in `docs/impl/v0-decisions.md`
4. Pass minimum 8 conformance tests
5. Be wired into `packages/mcp-server/src/router.ts`

Open a Discussion before starting adapter work — the maintainer
can advise on tree-sitter grammar maturity and routing decisions.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
