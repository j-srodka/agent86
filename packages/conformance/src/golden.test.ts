import { describe, it } from "vitest";

/**
 * Task 8 will add determinism, template/decorator, and edit-shift tests here.
 *
 * Edit-shift (plan Step 4): MUST materialize snapshot A, apply a real `replace_unit`
 * to the lower stacked unit, materialize snapshot B, then assert Tier I ids per
 * `packages/ts-adapter/src/units.ts`. A second identical materialize of the same
 * sources is not a substitute — see `docs/impl/v0-decisions.md` (Conformance goldens).
 */
describe("conformance goldens (Task 8)", () => {
  it.todo(
    "edit-shift: real replace_unit on lower unit then re-snapshot; ids above stable, at/below change",
  );
});
