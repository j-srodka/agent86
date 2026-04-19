# Agent86

**Agent86 is the rejection-code contract for AI code editing: structured ops, normative rejection codes agents can branch on, and a typed SDK for programmable refactors.**

## The problem

Agents still ship **string-match patches**, get **prose-only** errors they cannot branch on, and hit **silent partial failures** when tooling reports success but the wrong nodes changed. The idea that **structured AST-level ops beat raw string edits** is increasingly well explored—notably by recent agent frameworks—but **what is missing** is a **portable contract**: a stable interchange where failures return **normative, machine-readable codes** (not ad hoc messages) so every integration can recover the same way.

## What this is

**(a)** A **locked v0 spec** with a normative **§12.1 rejection-code table**—the taxonomy agents are meant to switch on. **(b)** **Reference adapters** for **TypeScript**, **JavaScript**, and **Python** (Tree-sitter–backed snapshot materialization and `applyBatch`). **(c)** A **typed workspace SDK**, **`@agent86/sdk`** (v3), for structured unit search and fluent op batches with optional **snapshot coherence checks** before `apply_batch` hits the wire.

**What it is not:** not a new programming language; **not** a replacement for **LSP** or **MCP** (it complements them—see [`packages/mcp-server/README.md`](packages/mcp-server/README.md)); **not** a promise of production hardening everywhere (the v0 **spec** is locked, but auth, quotas, and trust boundaries are yours).

## Quickstart

Use **`@agent86/sdk`** from this workspace (`private`; not published to npm). **`Agent86JsonRpcTransport`** posts **JSON-RPC** `tools/call` to an **HTTP** endpoint—set **`AGENT86_MCP_ENDPOINT`** or pass `endpoint` to whatever **MCP gateway** your environment exposes (the wire shape is documented on `Agent86JsonRpcTransport` in `packages/sdk`). That is **not** the same as the reference **`@agent86/mcp-server`** process, which speaks **MCP over stdio** (`node packages/mcp-server/dist/index.js`). To use the SDK against this repo’s server you need a **stdio-to-HTTP bridge** from your host, or skip the transport and invoke MCP tools / **`ts-adapter`** directly in-process. **`search()`** requires a host that registers **`search_units`** (v3); otherwise it throws **`Agent86VersionSkewError`**.

```typescript
import {
  Agent86JsonRpcTransport,
  Agent86Sdk,
  Agent86VersionSkewError,
} from "@agent86/sdk";

// Constructor resolves `endpoint` immediately; it throws if you omit it and `AGENT86_MCP_ENDPOINT` is unset.
const transport = new Agent86JsonRpcTransport({
  endpoint: process.env.AGENT86_MCP_ENDPOINT ?? "http://127.0.0.1:3000/mcp",
});
const sdk = new Agent86Sdk({ transport });

const root_path = "/absolute/path/to/workspace";

// 1. Materialize a snapshot via MCP (tool: materialize_snapshot)
// — the SDK accepts the resulting snapshot_id.
const snapshot_id = /* from materialize_snapshot */;

// 2. Find units with structured filters.
let methods;
try {
  methods = await sdk.search(
    { kind: "method", name: "authenticate", enclosing_class: "UserService" },
    { root_path, snapshot_id },
  );
} catch (e) {
  if (!(e instanceof Agent86VersionSkewError)) throw e;
  // Host missing `search_units` or legacy payload — deploy v3 `packages/mcp-server` or a compatible HTTP gateway.
  throw e;
}

// 3. Build a batch of ops. Pass source_snapshot_id to enable SDK-side
//    snapshot coherence checks (recommended; opt-in for backward compat).
const report = await sdk
  .builder()
  .renameSymbol({
    target_id: methods[0].id,
    source_snapshot_id: methods[0].snapshot_id, // enables mismatch detection
    new_name: "verify",
    cross_file: true,
  })
  .apply({ snapshot_id, root_path });

// 4. Branch on rejection codes — the contract Agent86 provides.
if (report.outcome !== "success") {
  for (const entry of report.entries) {
    switch (entry.code) {
      case "lang.ts.cross_file_rename_broad_match":
        // Example scenario: narrow matches and retry (see MCP README)—not a benchmarked claim.
        break;
      case "lang.agent86.snapshot_id_mismatch":
        // re-materialize and rebuild
        break;
      case "ghost_unit":
      case "stale_snapshot":
        // re-materialize snapshot
        break;
    }
  }
}
```

## What's included

| Component | Location / role |
| --------- | ---------------- |
| **Locked spec** | [`docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md`](docs/superpowers/specs/2026-04-12-agent-ir-and-ai-language-design.md) |
| **SDK (v3)** | [`packages/sdk/`](packages/sdk/) — `search`, `Agent86Sdk`, batch `builder`, coherence helpers |
| **Adapters** | [`packages/ts-adapter/`](packages/ts-adapter/), [`packages/js-adapter/`](packages/js-adapter/), [`packages/py-adapter/`](packages/py-adapter/) |
| **MCP server** | [`packages/mcp-server/`](packages/mcp-server/) — stdio tools (see below) |
| **Conformance goldens** | [`packages/conformance/`](packages/conformance/) |
| **A/B harness** | [`packages/ab-harness/`](packages/ab-harness/) — directional benchmark vs string baseline (see writeup) |

Implementation plan: [`docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md`](docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md). Decision log: [`docs/impl/v0-decisions.md`](docs/impl/v0-decisions.md). Deeper measurement narrative: [`docs/writeup/false-positive-problem.md`](docs/writeup/false-positive-problem.md).

Collaboration rules: [`AGENTS.md`](AGENTS.md). Cursor rules: [`.cursor/rules/agent86.mdc`](.cursor/rules/agent86.mdc).

## Related work

Related work: AWS AI Labs' [CodeStruct](https://arxiv.org/abs/2604.05407) (arXiv, April 2026) proposes a structured action space for code agents with readCode / editCode primitives over AST entities, benchmarked on SWE-Bench Verified. Agent86 is complementary: where CodeStruct operates as an agent framework, Agent86 is a portable contract — a locked spec with a normative rejection-code taxonomy (§12.1) that any framework, CLI, or custom agent can emit against. The SDK is one reference consumer; other frameworks could be others. The overlap is the "AST ops beat string edits" insight; the distinction is what gets standardized and what layer it lives at.

## Status and roadmap

- **`@agent86/sdk` v3** is in-repo (workspace package); MCP adds **`search_units`** for structured filters used by `sdk.search()`.
- **Cross-language reference search** (unified queries across ts/js/py graphs) is **planned**; today search is routed per language like the rest of the stack—see `docs/impl/v0-decisions.md`.
- **A/B benchmark** (expanded harness, three OSS repos): IR false positives **0** on the canonical run is a **structural** observation; **failed-patch-rate** comparisons use **Wilson 95% CIs** that **overlap at n=20**—treat that delta as **directional**, not statistically definitive. Full methodology: [`docs/writeup/false-positive-problem.md`](docs/writeup/false-positive-problem.md).
- **Roadmap (non-exhaustive):** `.gitignore`-aware walking, `.jsx`/`.tsx` parsing paths, more adapters—see MCP README for current scoping caveats below.

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

## MCP tools (stdio server, registration order)

| Tool | Purpose |
| ---- | ------- |
| `materialize_snapshot` | Build a content-addressed `WorkspaceSnapshot` (cache by `snapshot_id`). |
| `list_units` | List logical units for a workspace (internal materialization; ids are not interchangeable with other tools’ snapshots—see MCP README). |
| `search_units` | Structured filter search; normative `{ unit_refs }` payload for SDK v3. |
| `build_workspace_summary` | Workspace summary / manifest hints for agent planning. |
| `apply_batch` | Apply validated op batches; returns `ValidationReport` with §12.1 codes. |
| `get_session_report` | Session tally (ops, batches, rejection codes, warnings). |

## Apply path and interchange (spec section 9)

For **`applyBatch`**, the reference adapter enforces (in order): on-disk **grammar artifact** matches the checked-in digest (**Gate 1**), **`WorkspaceSnapshot.grammar_digest`** matches the applying adapter (**Gate 2**), **`AdapterFingerprint`** on the snapshot matches **`V0_ADAPTER_FINGERPRINT`** (name, semver, grammar digest, **`max_batch_ops`**), and **`ops.length ≤ max_batch_ops`**.

**CI / golden workflows** should materialize snapshots with this adapter and treat **full fingerprint equality** as the interchange contract so sessions do not drift across adapter builds.

**Local development:** you still need a matching **grammar digest** on the snapshot and a matching **artifact** on disk; the implementation does not offer a “digest-only, ignore adapter identity” shortcut in the apply path. If you change **`tree-sitter-typescript`** or the adapter fingerprint, re-materialize snapshots and update any pinned constants per **`docs/impl/v0-decisions.md`**.

The same §9 gates apply to `@agent86/py-adapter` and `@agent86/js-adapter`; each adapter pins its own grammar digest constant (see `docs/impl/v0-decisions.md`).

## Known limitations

Operational caveats (details in [`packages/mcp-server/README.md`](packages/mcp-server/README.md)):

- **Snapshot scope:** the MCP server walks **all** matching sources under `root_path` and does **not** consult `.gitignore`; broad roots can drag in caches and enlarge cross-file rename matches—use a narrow `root_path` when possible.
- **Syntax surfaces:** **`.tsx`** is not parsed as TypeScript; **`.jsx`** is not parsed as JavaScript—paths are reported on the snapshot as skipped.
- **Mixed-language batches:** a single `apply_batch` may apply **ts**, then **py**, then **js**; there is **no cross-language rollback** if a later leg fails after an earlier one wrote disk.
- **Harness vs live agents:** the A/B harness exercises mechanical baseline vs IR tasks; it does not prove end-to-end behavior for a full autonomous agent loop (see the writeup §6).

**Spec changes:** propose via [`docs/impl/spec-proposals.md`](docs/impl/spec-proposals.md); humans apply edits to the locked spec file.

## Contributing

See [`AGENTS.md`](AGENTS.md) for collaboration rules and commit conventions. [CHANGELOG](CHANGELOG.md) records release history.

## License

License: **Apache-2.0**
