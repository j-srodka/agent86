# Agent86

**Agent86** is a portable, versioned interchange for agent-to-tool and agent-to-agent code editing: **ops**, **snapshots**, **validation reports**, and **rejection codes** agents can branch on deterministically—instead of prose errors they have to parse.

**Status:** v2.2+ — three language adapters (TypeScript, JavaScript, Python), **`@agent86/sdk`** (typed MCP client: fluent builder + `search_units`), MCP server with **six** tools, A/B benchmark harness, and conformance goldens. See [CHANGELOG](CHANGELOG.md) for full history.

## The problem

Agents editing code today still lean on brittle **line-number** references, get **prose-only** failures from tools, and often **read whole files** when they only need one function. There is **no portable** way to say “apply this validated edit” or “reject with a machine-readable reason” that works the same across editors, CLIs, and custom glue. Every agent–tool pair ends up inventing another **incompatible JSON dialect** for the same handful of operations. That is not a programming-language syntax problem—it is a **missing contract layer** between agents and the software that actually touches the tree.

## What this is

A small **Agent86** (intermediate representation): a **locked spec** plus a **reference implementation** defining `WorkspaceSnapshot` (content-addressed, grammar-pinned), `LogicalUnit` (the smallest stable patch target), a minimal **Op** vocabulary for v0 (`replace_unit`, `rename_symbol`, `move_unit` (cross-file)), and `ValidationReport` with **normative rejection codes** agents can branch on deterministically (see the spec’s validation code table). The IR sits **above** host machinery (LSP, Tree-sitter, `tsc`, formatters) and **below** agent reasoning—it is the **contract**, not a replacement for either layer.

**What it is not:**

- **Not** a new general-purpose programming language (optional later surface / skin is out of scope for v0).
- **Not** a replacement for **LSP** or **MCP** — it **complements** them. Agent86 adds a normative op vocabulary, content-addressed snapshots, and structured ValidationReports that MCP alone does not provide. An Agent86 MCP server ships in `packages/mcp-server/` for direct Cursor and Claude Code integration.
- **Not** a guarantee of production hardening everywhere: the v0 **spec** is stable and locked, but operational hardening (auth, rate limiting, multi-user trust boundaries) is your responsibility as an adopter.

## Normative documents

| Document | Role |
| -------- | ---- |
| [`docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md`](docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md) | **Locked** v0 product spec (agents do not edit in-repo; amendments via `docs/impl/spec-proposals.md` + human apply). |
| [`docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md`](docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md) | Implementation plan (task order, verification commands). |
| [`docs/impl/v0-decisions.md`](docs/impl/v0-decisions.md) | Repo-specific behavior: grammar digest, canonical bytes, apply gates, manifest path, etc. |
| [`docs/writeup/false-positive-problem.md`](docs/writeup/false-positive-problem.md) | Published benchmark writeup — the false positive problem in AI code editing |

## Repo layout

| Path | Purpose |
| ---- | ------- |
| `packages/ts-adapter/` | **TypeScript** adapter: snapshot materialization, `applyBatch`, `WorkspaceSummary`, manifest discovery. |
| `packages/py-adapter/` | **Python** adapter: same interface as ts-adapter, tree-sitter-python grammar. |
| `packages/js-adapter/` | **JavaScript** adapter (.js/.mjs/.cjs): same interface, tree-sitter-javascript grammar. |
| `packages/mcp-server/` | **MCP server**: six tools over stdio — `materialize_snapshot`, `list_units`, **`search_units`**, `build_workspace_summary`, `apply_batch`, `get_session_report`. See [`packages/mcp-server/README.md`](packages/mcp-server/README.md). |
| `packages/sdk/` | **`@agent86/sdk`**: typed client over MCP (`builder`, `search`, JSON-RPC transport). **Not** a sandbox runtime — agents run the SDK in their own process (Cursor, Claude Code, Node harness). |
| `packages/conformance/` | Golden fixtures + Vitest runner (determinism, edit-shift ids, cross-file ops). |
| `packages/ab-harness/` | A/B harness: baseline vs IR-backed tasks across three OSS repos (Zod, Prettier, Ruff). See [`packages/ab-harness/README.md`](packages/ab-harness/README.md). |
| [`examples/cross-rename-demo/`](examples/cross-rename-demo/README.md) | Small TS demo tree: many cross-file refs to exercise **`lang.ts.cross_file_rename_broad_match`** and narrowing patterns. |

Collaboration rules: [`AGENTS.md`](AGENTS.md). Cursor rules: [`.cursor/rules/agent86.mdc`](.cursor/rules/agent86.mdc).

## Running the stack

See [docs/writeup/false-positive-problem.md](docs/writeup/false-positive-problem.md) for benchmark results and methodology.

**Prerequisites:** Node 22+, **pnpm** (see root `package.json` for `packageManager`).

```bash
pnpm install
pnpm -r build
pnpm --filter ts-adapter test
pnpm --filter conformance test
```

**Python and JavaScript adapters:**

```bash
pnpm --filter @agent86/py-adapter test
pnpm --filter @agent86/js-adapter test
pnpm --filter @agent86/sdk test
```

**MCP server (build + smoke tests):**

```bash
pnpm --filter @agent86/mcp-server build
pnpm --filter @agent86/mcp-server test
```

**MCP server (run for Cursor / Claude Code):**

```bash
node packages/mcp-server/dist/index.js
```

See `packages/mcp-server/README.md` for the Cursor and Claude Code `mcpServers` config block.

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

The same §9 gates apply to `@agent86/py-adapter` and `@agent86/js-adapter`; each adapter pins its own grammar digest constant (see `docs/impl/v0-decisions.md`).

## Using Agent86

**MCP server (recommended):** Add `packages/mcp-server/` to your Cursor or Claude Code MCP config. The server exposes **six** tools — call `materialize_snapshot` at session start, use **`search_units`** for structured unit lookup, use `apply_batch` for all `.ts`, `.js`, and `.py` edits, and call `get_session_report` to see IR activity. See [`packages/mcp-server/README.md`](packages/mcp-server/README.md) for the full config block and tool reference.

### TypeScript SDK (`@agent86/sdk`)

The SDK is a **typed MCP client**: it serializes tool calls and surfaces **`ValidationReport`** — it does **not** execute agent-authored programs (no embedded V8 isolate). Configure transport with an HTTP JSON-RPC endpoint (`AGENT86_MCP_ENDPOINT` or constructor option) that speaks MCP-style `tools/call`.

**Quickstart — always thread `UnitRef.snapshot_id` into `source_snapshot_id` on every op** so the SDK can reject compose-time snapshot skew locally (`lang.agent86.snapshot_id_mismatch`) without a wasteful `apply_batch` round trip:

```typescript
import { Agent86JsonRpcTransport, builder, search } from "@agent86/sdk";

const transport = new Agent86JsonRpcTransport({ endpoint: process.env.AGENT86_MCP_ENDPOINT });

const snapshot_id = /* from materialize_snapshot */;
const root_path = /* workspace root */;

const [svc] = await search({ kind: "method", name: "authenticate" }, { transport, root_path, snapshot_id });

const report = await builder(transport)
  .renameSymbol({
    target_id: svc.id,
    source_snapshot_id: svc.snapshot_id,
    new_name: "verify",
    cross_file: true,
  })
  .apply({ snapshot_id, root_path });
```

Omitting **`source_snapshot_id`** is allowed for backward compatibility, but then the SDK cannot detect batch-vs-apply snapshot skew at the client.

**Direct API:** Import from the workspace packages:

- `ts-adapter` — TypeScript and TSX-adjacent workspaces
- `@agent86/py-adapter` — Python workspaces
- `@agent86/js-adapter` — JavaScript (.js/.mjs/.cjs) workspaces

All three share the same interface: `materializeSnapshot`, `applyBatch`, `buildWorkspaceSummary`.

**Spec changes:** propose via `docs/impl/spec-proposals.md`; humans apply edits to the locked spec file.

## Relationship to structured-AST research (e.g. CodeStruct)

Recent research benchmarks often focus on **structured edit operators** or AST-shaped actions over large corpora. That line of work is **complementary**: it helps establish that tree-structured edits are a viable baseline. **Agent86’s emphasis** is different: a **normative rejection-code taxonomy** (`ValidationReport`, spec §12.1) and a **programmable** TypeScript surface so agents **branch on codes** (`batch_size_exceeded`, `lang.ts.cross_file_rename_broad_match`, `lang.agent86.snapshot_id_mismatch`, …) instead of inferring failure from prose. Benchmarks and interchange contracts answer different questions; adopters can use both.

**Roadmap:** `.gitignore`-aware file walking, `.jsx`/`.tsx` support, additional language adapters. Contributions welcome — see [AGENTS.md](AGENTS.md) for collaboration rules.

## Relationship to LSP and MCP

**LSP** is optimized for human-editor latency and rich IDE features; **MCP** provides transport and capability discovery. This project adds a layer those were not designed to own: a **normative op vocabulary**, **content-addressed snapshots**, and **structured validation reports** aimed at **autonomous agent** edit loops—not at replacing your language server or MCP server. The **`@agent86/sdk`** package targets **MCP transport only** (not LangChain/Cursor-specific shims); see `docs/impl/v0-decisions.md` — Agent86 SDK (v3).

## License

License: **Apache-2.0**
