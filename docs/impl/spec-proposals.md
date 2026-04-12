# Spec proposals

Proposed amendments to the locked spec. Each entry must include: date, proposing agent, the proposed change as a diff or clearly marked block, and rationale. A human must approve and apply any proposal to the spec file.

---

## 2026-04-12 — `id_superseded` warning code (Cursor)

**Rationale:** v1 `move_unit` + section 8 auto-resolve emits an explicit **`id_superseded`** warning when an op `target_id` is resolved via `id_resolve` so resolution is never silent. The locked spec section 12.1 table does not yet list this code.

**PROPOSED — add to section 12.1 (Identity and addressing), new row:**

| `id_superseded` | W | Op `target_id` was a superseded id; the adapter resolved it via `id_resolve` to a live unit. | Confirm the op was intended for the resolved location; use `evidence.resolved_to`. |

---
