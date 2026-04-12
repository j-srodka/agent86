import { describe, it } from "vitest";

/**
 * Implementation plan: `docs/superpowers/plans/2026-04-12-agent-ir-v0-implementation.md`
 *
 * The `it.todo` below is the **checklist hook for Task 8 Step 4** (edit-shift id golden).
 * It must be replaced with a real test before Task 8 sign-off — see `docs/impl/v0-decisions.md`
 * (Conformance goldens — Sign-off gate).
 */
describe("Task 8 — conformance goldens", () => {
  describe("Step 4 — Edit-shift id golden (implementation plan checklist; blocking until implemented)", () => {
    it.todo(
      "[Task 8 Step 4] Fixture with ≥2 units in one file (stacked vertically). Snapshot A → record ids. Apply replace_unit to the lower unit only → snapshot B. Assert: edited unit id changed; unit above edit same id; unit below edit (if any) id changed — per packages/ts-adapter/src/units.ts. Do not substitute a second identical materialize of unchanged sources.",
    );
  });
});
