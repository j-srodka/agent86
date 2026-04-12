# v0 implementation decisions

Implementation-time choices for the Agent IR v0 reference stack (per [implementation plan](../superpowers/plans/2026-04-12-agent-ir-v0-implementation.md)). The product spec remains locked; this file is the normative log for repo-specific behavior.

## Grammar digest (v0, normative for this repo)

*The single-artifact SHA-256 strategy and checked-in digest constant are written in Task 2 Step 1 before any parser or digest code. This subsection is the gate.*

**Bump policy — triggers (normative for when to re-hash and update the constant):**

1. **Lockfile package version change:** The pinned `tree-sitter-typescript` version in `pnpm-lock.yaml` (or equivalent) changes — re-hash the chosen artifact, update the in-repo digest constant, record a changelog entry, and treat as **breaking** for snapshot compatibility with prior digests.
2. **Artifact path or format change:** The implementation switches which file is hashed (e.g. WASM vs `parser.c`) or the package layout delivers a different on-disk artifact for the same semver — re-hash, update constant, same breaking snapshot semantics as (1).
3. **Intentional grammar bump without npm churn:** Rare case where the npm version is unchanged but the vendored or resolved artifact was replaced (e.g. manual pin fix) — re-hash and update if the file bytes differ.

*Deferred until Task 2 Step 1: exact artifact choice, `GRAMMAR_DIGEST_V0` value, and CI check that computed hash matches the constant.*

## Canonical bytes and line endings

*TBD (Task 3).*

## Tier I unit ids and `rename_symbol` / `id_resolve` delta

*TBD (Tasks 3 and 6).*

## Manifest discovery (spec section 16)

*TBD (Task 10).*

## Pinned OSS monorepo for A/B harness

*TBD (Task 9).*

## Op JSON shape (v0 subset: `replace_unit`, `rename_symbol`)

*TBD (Tasks 5–6 as shapes stabilize).*