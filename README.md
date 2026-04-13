# agent86

**agent86** is a portable, versioned interchange for agent-to-tool and agent-to-agent code editing: **ops**, **snapshots**, **validation reports**, and **rejection codes** agents can branch on deterministically—instead of prose errors they have to parse.

**Status:** v0 **reference stack complete** in this repo: TypeScript adapter (Tree-sitter), conformance goldens, A/B harness, and manifest discovery—see **`docs/impl/v0-decisions.md`** and the locked spec below.

## The problem

Agents editing code today still lean on brittle **line-number** references, get **prose-only** failures from tools, and often **read whole files** when they only need one function. There is **no portable** way to say “apply this validated edit” or “reject with a machine-readable reason” that works the same across editors, CLIs, and custom glue. Every agent–tool pair ends up inventing another **incompatible JSON dialect** for the same handful of operations. That is not a programming-language syntax problem—it is a **missing contract layer** between agents and the software that actually touches the tree.

## What this is

A small **Agent IR** (intermediate representation): a **locked spec** plus a **reference implementation** defining `WorkspaceSnapshot` (content-addressed, grammar-pinned), `LogicalUnit` (the smallest stable patch target), a minimal **Op** vocabulary for v0 (`replace_unit`, `rename_symbol`), and `ValidationReport` with **normative rejection codes** agents can branch on deterministically (see the spec’s validation code table). The IR sits **above** host machinery (LSP, Tree-sitter, `tsc`, formatters) and **below** agent reasoning—it is the **contract**, not a replacement for either layer.

**What it is not:**

- **Not** a new general-purpose programming language (optional later surface / skin is out of scope for v0).
- **Not** a replacement for **LSP** or **MCP**—it **complements** them (see below).
- **Not** a guarantee of production hardening everywhere: v0 is a **prototype**; tighten operational policies after you validate the shape in your environment.

## Normative documents

| Document | Role |
| -------- | ---- |
| [`docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md`](docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md) | **Locked** v0 product spec (agents do not edit in-repo; amendments via `docs/impl/spec-proposals.md` + human apply). |
| [`docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md`](docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md) | Implementation plan (task order, verification commands). |
| [`docs/impl/v0-decisions.md`](docs/impl/v0-decisions.md) | Repo-specific behavior: grammar digest, canonical bytes, apply gates, manifest path, etc. |

## Repo layout

| Path | Purpose |
| ---- | ------- |
| `packages/ts-adapter/` | Reference **TypeScript** adapter: snapshot materialization, `applyBatch`, `WorkspaceSummary`, manifest discovery (`agent-ir.manifest.json`). |
| `packages/conformance/` | Golden fixtures + Vitest runner (determinism, edit-shift ids). |
| `packages/ab-harness/` | A/B harness: baseline vs IR-backed tasks, `ab-metrics.json`; see [`packages/ab-harness/README.md`](packages/ab-harness/README.md). |

Collaboration rules: [`AGENTS.md`](AGENTS.md). Cursor rules: [`.cursor/rules/agent86.mdc`](.cursor/rules/agent86.mdc).

## Running the v0 stack

**Prerequisites:** Node 22+, **pnpm** (see root `package.json` for `packageManager`).

```bash
pnpm install
pnpm -r build
pnpm --filter ts-adapter test
pnpm --filter conformance test
```

Always run **`pnpm -r build`** before **`pnpm --filter conformance test`** when **`packages/ts-adapter/`** has changed (conformance exercises the adapter’s built **`dist`**).

**A/B harness** (clones a pinned OSS repo under `.cache/ab-target/`; see [`packages/ab-harness/README.md`](packages/ab-harness/README.md)):

```bash
pnpm ab:bench
# or: pnpm --filter ab-harness start
```

Defaults: **`TARGET_REPO_URL`** and **`TARGET_REPO_REV`** resolve to the pinned Zod commit in **`packages/ab-harness/.pinned-rev`**. Override those env vars to use another checkout.

**Expanded multi-repo benchmark** (Zod + Prettier + Ruff, seeded tasks, `ab-metrics-expanded.json`): run **`pnpm ab:bench:expanded`** (or `pnpm --filter ab-harness start -- --profile expanded`). Metrics and `ab-tasks-*.json` are written under **`packages/ab-harness/`** by default (`AB_METRICS_OUT` overrides).

## Apply path and interchange (spec section 9)

For **`applyBatch`**, the reference adapter enforces (in order): on-disk **grammar artifact** matches the checked-in digest (**Gate 1**), **`WorkspaceSnapshot.grammar_digest`** matches the applying adapter (**Gate 2**), **`AdapterFingerprint`** on the snapshot matches **`V0_ADAPTER_FINGERPRINT`** (name, semver, grammar digest, **`max_batch_ops`**), and **`ops.length ≤ max_batch_ops`**.

**CI / golden workflows** should materialize snapshots with this adapter and treat **full fingerprint equality** as the interchange contract so sessions do not drift across adapter builds.

**Local development:** you still need a matching **grammar digest** on the snapshot and a matching **artifact** on disk; the implementation does not offer a “digest-only, ignore adapter identity” shortcut in the apply path. If you change **`tree-sitter-typescript`** or the adapter fingerprint, re-materialize snapshots and update any pinned constants per **`docs/impl/v0-decisions.md`**.

## Handoff and next steps

- **Integration:** Import **`ts-adapter`** from the workspace package; use **`await buildWorkspaceSummary(snapshot, snapshotRootPath)`** (async) with the same root passed to **`materializeSnapshot`**. Optional manifest: **`agent-ir.manifest.json`** at that root sets **`WorkspaceSummary.manifest_url`** (see **`docs/impl/v0-decisions.md`**).
- **Spec changes:** propose via **`docs/impl/spec-proposals.md`**; humans apply edits to the locked spec file.
- **v1 roadmap:** cross-file ops, richer manifest validation, TSX grammar scope, and other items called out in the plan’s “Out of scope” section and in **`docs/impl/v0-decisions.md`** (e.g. strict manifest JSON in v1).

External review: **`AGENTS.md`** describes relaying stress-test passes through **Claude (claude.ai)** when you want a second pair of eyes on reports and diffs.

## Relationship to LSP and MCP

**LSP** is optimized for human-editor latency and rich IDE features; **MCP** provides transport and capability discovery. This project adds a layer those were not designed to own: a **normative op vocabulary**, **content-addressed snapshots**, and **structured validation reports** aimed at **autonomous agent** edit loops—not at replacing your language server or MCP server.

## License

License: **TBD**
